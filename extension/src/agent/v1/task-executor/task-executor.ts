import Anthropic from "@anthropic-ai/sdk"
import { ExtensionProvider } from "../../../providers/extension-provider"
import { isV1ClaudeMessage } from "../../../shared/messages/extension-message"
import { toolResponseToAIState } from "../../../shared/format-tools"
import { KODU_ERROR_CODES, KoduError, koduSSEResponse } from "../../../shared/kodu"
import { ChatTool } from "../../../shared/new-tools"
import { ChunkProcessor } from "../chunk-proccess"
import { StateManager } from "../state-manager"
import { ToolExecutor } from "../tools/tool-executor"
import { ApiHistoryItem, ToolResponseV2, UserContent } from "../types"
import { cleanUIMessages, formatImagesIntoBlocks, isTextBlock } from "../utils"
import { TaskError, TaskExecutorUtils, TaskState } from "./utils"
import { CustomProviderError } from "../../../api/providers/custom-provider"

export class TaskExecutor extends TaskExecutorUtils {
	public state: TaskState = TaskState.IDLE
	private toolExecutor: ToolExecutor
	private currentUserContent: UserContent | null = null
	private isRequestCancelled: boolean = false
	private _abortController: AbortController | null = null
	private consecutiveErrorCount: number = 0
	private isAborting: boolean = false
	private streamPaused: boolean = false
	private textBuffer: string = ""
	private _currentReplyId: number | null = null
	private _currentStreamTs: number | null = null
	private pauseNext: boolean = false
	private lastResultWithCommit: ToolResponseV2 | undefined = undefined

	constructor(stateManager: StateManager, toolExecutor: ToolExecutor, providerRef: WeakRef<ExtensionProvider>) {
		super(stateManager, providerRef)
		this.toolExecutor = toolExecutor
	}

	get currentStreamTs(): number | null {
		return this._currentStreamTs
	}

	get currentReplyId(): number | null {
		return this._currentReplyId
	}

	get abortController(): AbortController | null {
		return this._abortController
	}

	protected getState(): TaskState {
		return this.state
	}

	public async pauseStream() {
		if (!this.streamPaused) {
			// Ensure any buffered content is flushed before pausing
			if (this._currentReplyId !== null && this.textBuffer) {
				await this.flushTextBuffer(this._currentReplyId)
			}
			this.streamPaused = true
		}
	}

	public async resumeStream() {
		if (this.streamPaused) {
			try {
				// Ensure any pending operations are complete
				if (this.textBuffer && this._currentReplyId) {
					await this.flushTextBuffer(this._currentReplyId)
				}
				this.streamPaused = false
			} catch (err) {
				console.error("Error resuming stream:", err)
				// Continue with resume even if flush fails
				this.streamPaused = false
			}
		}
	}

	private async flushTextBuffer(currentReplyId?: number | null) {
		if (!this.textBuffer || !currentReplyId) {
			return
		}
		const contentToFlush = this.textBuffer
		this.textBuffer = "" // Clear buffer immediately

		// Check for ask messages that need to be handled in order
		const lastAskTs = this.stateManager.state.claudeMessages
			.slice()
			.reverse()
			.find((msg) => msg.type === "ask")?.ts
		if (lastAskTs && lastAskTs > currentReplyId && contentToFlush.trim().length > 0) {
			// Create new message to maintain order
			this._currentReplyId = await this.say("text", contentToFlush, undefined, Date.now(), {
				isSubMessage: true,
			})
		} else {
			// Process UI updates in parallel with fire-and-forget
			void this.stateManager.providerRef.deref()?.getWebviewManager()?.postBaseStateToWebview()
			void this.stateManager.claudeMessagesManager
				.appendToClaudeMessage(currentReplyId, contentToFlush, true)
				.then(() => {
					// fire and forget
				})
		}
	}

	public async newMessage(message: UserContent) {
		if (this.isAborting) {
			throw new Error("Cannot start new message while aborting")
		}
		this.logState("New message")
		this.state = TaskState.WAITING_FOR_API
		this.isRequestCancelled = false
		this._abortController = new AbortController()
		this.currentUserContent = message
		const images = message.filter((item) => item.type === "image").map((item) => item.source.data)

		await this.say("user_feedback", message[0].type === "text" ? message[0].text : "New message", images)
		await this.makeClaudeRequest()
	}

	public async startTask(userContent: UserContent): Promise<void> {
		if (this.isAborting) {
			throw new Error("Cannot start task while aborting")
		}
		this.logState("Starting task")
		this.state = TaskState.WAITING_FOR_API
		this.currentUserContent = this.normalizeUserContent(userContent)
		this.isRequestCancelled = false
		this._abortController = new AbortController()
		this.consecutiveErrorCount = 0
		await this.makeClaudeRequest()
	}

	public async resumeTask(userContent: UserContent): Promise<void> {
		if (this.isAborting) {
			throw new Error("Cannot resume task while aborting")
		}
		if (this.state === TaskState.WAITING_FOR_USER) {
			this.logState("Resuming task")
			this.state = TaskState.WAITING_FOR_API
			this.currentUserContent = this.normalizeUserContent(userContent)
			this.isRequestCancelled = false
			this.consecutiveErrorCount = 0
			this._abortController = new AbortController()
			await this.makeClaudeRequest()
		} else {
			this.logError(new Error("Cannot resume task: not in WAITING_FOR_USER state") as TaskError)
		}
	}

	private normalizeUserContent(content: UserContent): UserContent {
		if (content.length === 0 || (content[0]?.type === "text" && !content[0].text?.trim())) {
			return [{ type: "text", text: "Let's continue with the task, from where we left off." }]
		}
		return content
	}

	public async abortTask(): Promise<void> {
		if (this.isAborting) {
			return
		}

		this.isAborting = true
		try {
			this.logState("Aborting task")
			const now = Date.now()

			// first make the state to aborted
			this.state = TaskState.ABORTED
			this._abortController?.abort()
			this.isRequestCancelled = true

			// First reject any pending asks to prevent tools from continuing
			await this.askManager.abortPendingAsks()

			// Cleanup tool executor
			await this.toolExecutor.abortTask()

			// Reset state
			await this.resetState()

			// Cancel the current request
			await this.cancelCurrentRequest()

			this.logState(`Task aborted in ${Date.now() - now}ms`)
		} finally {
			this.isAborting = false
		}
	}

	private async cancelCurrentRequest(): Promise<void> {
		if (this.isRequestCancelled) {
			return // Prevent multiple cancellations
		}

		// Check if this is the first message
		if (this.stateManager.state.claudeMessages.length === 2) {
			return // Can't cancel the first message
		}

		this.logState("Cancelling current request")
		this.isRequestCancelled = true
		this._abortController?.abort()
		this.state = TaskState.ABORTED

		// Find the last api request and tool request
		const lastApiRequest = this.stateManager.state.claudeMessages
			.slice()
			.reverse()
			.find((msg) => msg.type === "say" && msg.say === "api_req_started")

		const lastToolRequest = this.stateManager.state.claudeMessages
			.slice()
			.reverse()
			.find((msg) => {
				if (!isV1ClaudeMessage(msg) || msg.ask !== "tool") {
					return false
				}
				try {
					if (msg.text === "" || msg.text === "{}") {
						throw new Error("Tool message text is empty or invalid JSON")
					}
					const parsedTool = JSON.parse(msg.text ?? "{}") as ChatTool
					return parsedTool.approvalState !== "error"
				} catch (e) {
					return false
				}
			})

		// Update tool request if exists and not already approved
		if (lastToolRequest) {
			const parsedTool = JSON.parse(lastToolRequest.text ?? "{}") as ChatTool
			if (parsedTool.approvalState !== "approved") {
				await this.updateAsk(
					lastToolRequest.ask!,
					{
						tool: {
							...parsedTool,
							approvalState: "error",
							error: "Task was interrupted before this tool call could be completed.",
						},
					},
					lastToolRequest.ts
				)
			}
		}

		// Update API request if exists and not done
		if (lastApiRequest && isV1ClaudeMessage(lastApiRequest) && !lastApiRequest.isDone) {
			const msg = await this.stateManager.claudeMessagesManager.updateClaudeMessage(
				lastApiRequest.ts,
				{
					...lastApiRequest,
					isDone: true,
					isFetching: false,
					errorText: "Request cancelled by user",
					isError: true,
				},
				true
			)
		}

		this.ask("resume_task", {
			question:
				"Task was interrupted before the last response could be generated. Would you like to resume the task?",
		}).then(async (res) => {
			if (res.response === "yesButtonTapped") {
				this.state = TaskState.WAITING_FOR_API
				this.isAborting = false
				this.resetState()
				this.currentUserContent = [
					{ type: "text", text: "Let's continue with the task, from where we left off." },
				]
				this.makeClaudeRequest()
			} else if ((res.response === "noButtonTapped" && res.text) || res.images) {
				const newContent: UserContent = []
				if (res.text) {
					newContent.push({ type: "text", text: res.text })
				}
				if (res.images) {
					const formattedImages = formatImagesIntoBlocks(res.images)
					newContent.push(...formattedImages)
				}
				await this.say("user_feedback", res.text, res.images)
				this.currentUserContent = newContent
				this.state = TaskState.WAITING_FOR_API
				this.isAborting = false
				this.resetState()
				this.makeClaudeRequest()
			} else {
				this.state = TaskState.COMPLETED
			}
		})
		await this.providerRef.deref()?.getWebviewManager()?.postBaseStateToWebview()
	}

	public async makeClaudeRequest(): Promise<void> {
		try {
			const provider = this.providerRef.deref()
			if (!provider?.koduDev) {
				return
			}
			if (this.pauseNext) {
				await this.handleWaitingForUser()
				return
			}
			if (
				this.state !== TaskState.WAITING_FOR_API ||
				!this.currentUserContent ||
				this.isRequestCancelled ||
				this.isAborting
			) {
				return
			}

			// Reset states
			await this.toolExecutor.resetToolState()
			this.isRequestCancelled = false
			this._abortController = new AbortController()
			this.streamPaused = false
			this.textBuffer = ""
			this._currentReplyId = null

			// fix any weird user content
			this.currentUserContent = this.fixUserContent(this.currentUserContent)

			if (this.consecutiveErrorCount >= 3) {
				const res = await this.ask("resume_task", {
					question: "Claude has encountered an error 3 times in a row. Would you like to resume the task?",
				})

				if (res.response === "yesButtonTapped" || res.response === "messageResponse") {
					this.say("user_feedback", res.text, res.images)
					this.resetState()
					this.consecutiveErrorCount = 0
				}
			}
			//
			this.logState("Making Claude API request")
			// Execute hooks before making the API request
			const startedReqId = await this.say("api_req_started")
			this._currentStreamTs = startedReqId
			if (provider?.koduDev) {
				// mark the task as uncompleted
				await provider.koduDev.markAsUncompleted()

				const hookContent = await provider.koduDev.executeHooks()
				if (hookContent) {
					// Add hook content to the user content
					if (Array.isArray(this.currentUserContent)) {
						this.currentUserContent.push({
							type: "text",
							text: hookContent,
						})
					}
				}
			}

			// Add user content to history and start request
			let attributesToAdd = {}
			if (this.lastResultWithCommit) {
				attributesToAdd = {
					preCommitHash: this.lastResultWithCommit.preCommitHash,
					commitHash: this.lastResultWithCommit.commitHash,
					branch: this.lastResultWithCommit.branch,
				}
				this.lastResultWithCommit = undefined
			}
			await this.stateManager.apiHistoryManager.addToApiConversationHistory({
				role: "user",
				content: this.currentUserContent,
				ts: startedReqId,
				...attributesToAdd,
			})

			// handle prompts for agent or sub-agent
			const systemPrompt = this.stateManager.subAgentManager.state?.systemPrompt
				? {
						systemPrompt: this.stateManager.subAgentManager.state?.systemPrompt,
						automaticReminders: this.stateManager.subAgentManager.state?.automaticReminders,
				  }
				: undefined

			const stream = await this.stateManager.apiManager.createApiStreamRequest(
				this.stateManager.state.apiConversationHistory,
				this._abortController,
				systemPrompt
			)

			if (this.isRequestCancelled || this.isAborting) {
				this._abortController?.abort()
				this.logState("Request cancelled, ignoring response")
				return
			}

			this.state = TaskState.PROCESSING_RESPONSE
			await this.processApiResponse(stream, startedReqId)
		} catch (error) {
			if (!this.isRequestCancelled && !this.isAborting) {
				if (error instanceof CustomProviderError) {
					console.log("[TaskExecutor] CustomProviderError:", error)
					await this.handleApiError(error)
					return
				}
				if (error instanceof KoduError) {
					console.log("[TaskExecutor] KoduError:", error)
					if (error.errorCode === KODU_ERROR_CODES.AUTHENTICATION_ERROR) {
						await this.handleApiError(new TaskError({ type: "UNAUTHORIZED", message: error.message }))
						return
					}
					if (error.errorCode === KODU_ERROR_CODES.PAYMENT_REQUIRED) {
						await this.handleApiError(new TaskError({ type: "PAYMENT_REQUIRED", message: error.message }))
						return
					}
					await this.handleApiError(new TaskError({ type: "API_ERROR", message: error.message }))
					return
				}
				if (`${error}`.includes("garbage collected")) {
					console.log("[TaskExecutor] Provider was garbage collected, ignoring error")
					return
				}
				// @ts-expect-error
				await this.handleApiError(new TaskError({ type: "NETWORK_ERROR", message: error.message }))
			} else {
				console.log("[TaskExecutor] Request was cancelled, ignoring error")
			}
		}
	}

	private async processApiResponse(
		stream: AsyncGenerator<koduSSEResponse, any, unknown>,
		startedReqId: number
	): Promise<void> {
		if (this.state !== TaskState.PROCESSING_RESPONSE || this.isRequestCancelled || this.isAborting) {
			return
		}

		try {
			this.logState("Processing API response")

			let ts = Date.now()

			const apiHistoryItem: ApiHistoryItem = {
				role: "assistant",
				ts,
				content: [
					{
						type: "text",
						text: "the response was interrupted in the middle of processing",
					},
				],
			}

			let accumulatedText = ""
			let accumReasoning = ""
			let firstChunkTs: number | null = null

			let reasoningLoading = false

			const processor = new ChunkProcessor({
				onStreamStart: async () => {
					ts = Date.now()
					apiHistoryItem.ts = ts

					await this.stateManager.apiHistoryManager.addToApiConversationHistory(apiHistoryItem)
				},
				onImmediateEndOfStream: async (chunk) => {
					if (this.isRequestCancelled || this.isAborting) {
						return
					}

					if (chunk.code === 1) {
						// console.log(`Updating chunk for API history item on chunk code 1`)
						const { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens } =
							chunk.body.internal
						const msg = await this.stateManager.claudeMessagesManager.updateClaudeMessage(
							startedReqId,
							{
								...this.stateManager.claudeMessagesManager.getMessageById(startedReqId)!,
								apiMetrics: {
									cost: chunk.body.internal.cost,
									inputTokens,
									outputTokens,
									inputCacheRead: cacheReadInputTokens,
									inputCacheWrite: cacheCreationInputTokens,
								},
								isDone: true,
								isFetching: false,
							},
							true
						)
						// apiHistoryItem.content = chunk.body.anthropic.content
						this.stateManager.providerRef.deref()?.getWebviewManager()?.postBaseStateToWebview()
					}

					if (chunk.code === -1) {
						const msg = await this.stateManager.claudeMessagesManager.updateClaudeMessage(
							startedReqId,
							{
								...this.stateManager.claudeMessagesManager.getMessageById(startedReqId)!,
								isDone: true,
								isFetching: false,
								errorText: chunk.body.msg ?? "Internal Server Error",
								isError: true,
							},
							true
						)
						this.stateManager.providerRef.deref()?.getWebviewManager()?.postBaseStateToWebview()
						throw new KoduError({ code: chunk.body.status ?? 500 })
					}
				},

				onChunk: async (chunk) => {
					// reset consecutive error count if data
					if (chunk.code !== 0 && chunk.code !== -1 && this.consecutiveErrorCount > 0) {
						this.consecutiveErrorCount = 0
					}
					if (this.isRequestCancelled || this.isAborting) {
						return
					}
					/**
					 * code 4 is for internal reasoning from the model (should not be saved to api history)
					 */
					if (chunk.code === 4) {
						accumReasoning += chunk.body.reasoningDelta
						this.updateSayPartial(startedReqId, {
							reasoning: {
								content: accumReasoning,
								...(!reasoningLoading
									? {
											startedAt: Date.now(),
									  }
									: {}),
							},
						})
						reasoningLoading = true
					}
					if (chunk.code === 2) {
						if (!firstChunkTs) {
							firstChunkTs = Date.now()
							const currentReplyId = await this.say("text", "", undefined, firstChunkTs, {
								isSubMessage: true,
							})
							this._currentReplyId = currentReplyId
							if (reasoningLoading) {
								// await this.sayWithId(reasoningTs, "reasoning", accumReasoning, undefined, {
								// 	isFetching: false,
								// 	completedAt: Date.now(),
								// })
								this.updateSayPartial(startedReqId, {
									reasoning: {
										finishedAt: Date.now(),
									},
								})
								reasoningLoading = false
							}
						}
						// Update API history first
						if (Array.isArray(apiHistoryItem.content) && isTextBlock(apiHistoryItem.content[0])) {
							apiHistoryItem.content[0].text =
								apiHistoryItem.content[0].text ===
								"the response was interrupted in the middle of processing"
									? chunk.body.text
									: apiHistoryItem.content[0].text + chunk.body.text
							await this.stateManager.apiHistoryManager.updateApiHistoryItem(ts, apiHistoryItem)
						}

						// Process chunk only if stream is not paused
						if (!this.streamPaused) {
							// Accumulate text until we have a complete XML tag or enough non-XML content
							accumulatedText += chunk.body.text
							// check if this chunk is inside tool
							const isChunkInsideTool = this.toolExecutor.isParserInToolTag()

							// Process for tool use and get non-XML text
							const nonXMLText = await this.toolExecutor.processToolUse(accumulatedText)
							// If we were in a tool and now we're not, the chunk contained a closing tag
							if (isChunkInsideTool && !this.toolExecutor.hasActiveTools()) {
								// Extract text after the closing tag
								const afterClosingTag = accumulatedText.split("</")[1]?.split(">")[1]
								if (afterClosingTag) {
									this.textBuffer += afterClosingTag
									await this.flushTextBuffer(this._currentReplyId)
								}
							} else if (!this.toolExecutor.hasActiveTools() && nonXMLText) {
								// Handle normal text chunks
								this.textBuffer += nonXMLText
								await this.flushTextBuffer(this._currentReplyId)
							}

							accumulatedText = "" // Clear accumulated text after processing

							// If tool processing started, pause the stream
							if (this.toolExecutor.hasActiveTools()) {
								this.pauseStream()
								await this.toolExecutor.waitForToolProcessing()
								this.textBuffer = ""
								await this.resumeStream()
							}
						}
					}
				},
				onFinalEndOfStream: async () => {
					if (this.isRequestCancelled || this.isAborting) {
						return
					}
					// Ensure all tools are processed
					await this.toolExecutor.waitForToolProcessing()
					this._currentReplyId = null

					await this.finishProcessingResponse(apiHistoryItem)
				},
			})

			await processor.processStream(stream)
		} catch (error) {
			if (this.isRequestCancelled || this.isAborting) {
				throw error
			}
			throw error
		}
	}

	private async resetState() {
		this._abortController?.abort()
		this.isRequestCancelled = false
		this._abortController = null
		this.consecutiveErrorCount = 0
		this.state = TaskState.WAITING_FOR_USER
		this.streamPaused = false
		this.textBuffer = ""
		this.pauseNext = false
		this._currentReplyId = null
	}

	public pauseNextRequest() {
		this.pauseNext = true
	}

	private async finishProcessingResponse(assistantResponses: ApiHistoryItem): Promise<void> {
		this.logState("Finishing response processing")
		if (this.isRequestCancelled || this.isAborting) {
			return
		}

		// Ensure no empty content in API history
		if (
			!assistantResponses.content.length ||
			(isTextBlock(assistantResponses.content[0]) && !assistantResponses.content[0].text.trim())
		) {
			if (assistantResponses.ts) {
				await this.stateManager.apiHistoryManager.updateApiHistoryItem(assistantResponses.ts, {
					role: "assistant",
					content: [{ type: "text", text: "Failed to generate a response, please try again." }],
				})
			}
		}

		const currentToolResults = await this.toolExecutor.getToolResults()

		if (currentToolResults.length > 0) {
			const completionAttempted = currentToolResults.find((result) => result?.name === "attempt_completion")

			this.state = TaskState.WAITING_FOR_API
			const resultWithCommit = currentToolResults
				.reverse()
				.find((result) => result.result.branch && result.result.commitHash)
			if (resultWithCommit) {
				this.lastResultWithCommit = resultWithCommit.result
			}
			// we have the git commit info here
			this.currentUserContent = currentToolResults.flatMap(({ result }) => {
				if (result) {
					return toolResponseToAIState(result)
				}
				return {
					type: "text",
					text: `The tool did not return a valid response.`,
				}
			})

			if (completionAttempted && completionAttempted.result.status === "success") {
				await this.stateManager.apiHistoryManager.addToApiConversationHistory({
					role: "user",
					content: toolResponseToAIState(completionAttempted.result),
				})
				await this.stateManager.apiHistoryManager.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "text",
							text: "Task completed successfully. please let me know if you want to resume or change something.",
						},
					],
				})
				this.state = TaskState.COMPLETED
				return
			}

			await this.makeClaudeRequest()
		} else {
			this.state = TaskState.WAITING_FOR_API
			this.currentUserContent = [
				{
					type: "text",
					text: `You must use a tool to proceed. Either use attempt_completion if you've completed the task, or ask_followup_question if you need more information. you must adhere to the tool format <kodu_action><tool_name><parameter1_name>value1</parameter1_name><parameter2_name>value2</parameter2_name>... additional parameters as needed in the same format ...</tool_name></kodu_action>`,
				},
			]
			await this.makeClaudeRequest()
		}
	}

	/**
	 * pause the task from continuing
	 */
	public blockTask() {
		this.state = TaskState.ABORTED
		this.isRequestCancelled = true
		this._abortController?.abort()
	}

	private async handleApiError(error: TaskError | CustomProviderError): Promise<void> {
		this.logError(error)
		console.log(`[TaskExecutor] Error (State: ${this.state}):`, error)
		await this.toolExecutor.resetToolState()

		const lastMessage = this.stateManager.state.apiConversationHistory.at(-1)
		if (lastMessage?.role === "assistant" && lastMessage.ts) {
			if (typeof lastMessage.content === "string") {
				lastMessage.content = [{ type: "text", text: lastMessage.content }]
			}
			if (Array.isArray(lastMessage.content) && isTextBlock(lastMessage.content[0])) {
				lastMessage.content[0].text =
					lastMessage.content[0].text.trim() ||
					"An error occurred in the generation of the response. Please try again."
			}
			await this.stateManager.apiHistoryManager.updateApiHistoryItem(lastMessage.ts, lastMessage)
		}
		if (lastMessage?.role === "user" && lastMessage.ts && lastMessage.ts === this._currentStreamTs) {
			// remove the last message from the history
			await this.stateManager.apiHistoryManager.deleteApiHistoryItem(lastMessage.ts)
		}
		const modifiedClaudeMessages = this.stateManager.state.claudeMessages.slice()
		// clean ui messages
		cleanUIMessages(modifiedClaudeMessages, error)

		// Process state updates in parallel

		await this.stateManager.claudeMessagesManager.overwriteClaudeMessages(modifiedClaudeMessages, undefined, true)
		this.consecutiveErrorCount++
		if (error instanceof TaskError && (error.type === "PAYMENT_REQUIRED" || error.type === "UNAUTHORIZED")) {
			this.state = TaskState.IDLE
			this.say(error.type === "PAYMENT_REQUIRED" ? "payment_required" : "unauthorized", error.message)
			return
		}
		if (error instanceof CustomProviderError) {
			this.state = TaskState.IDLE
			this.say(
				"custom_provider_error",
				JSON.stringify({
					providerId: error.providerId,
					modelId: error.modelId,
				})
			)
			return
		}

		// check if provider is available or not (this is useful to prevent adding failed error when panic exit is called)
		const provider = this.providerRef.deref()
		if (!provider) {
			this.state = TaskState.COMPLETED
			return
		}

		// Handle user response
		const { response } = await this.ask("api_req_failed", { question: error.message })

		if (response === "yesButtonTapped" || response === "messageResponse") {
			this.state = TaskState.WAITING_FOR_API

			// Start new request immediately
			this.makeClaudeRequest()
		} else {
			this.state = TaskState.COMPLETED
		}
	}

	/**
	 * @description corrects the user content to prevent any issues with the API.
	 * @param content the content that will be sent to API as a USER message in the AI conversation
	 * @returns fixed user content format to prevent any issues with the API
	 */
	private fixUserContent(content: UserContent): UserContent {
		if (content.length === 0) {
			return [{ type: "text", text: "The user didn't provide any content, please continue" }]
		}
		return content.map((item) => {
			if (item.type === "text" && item.text.trim().length === 0) {
				return { type: "text", text: "The user didn't provide any content, please continue" }
			}
			if (isTextBlock(item) && item.text.trim().length === 0) {
				return { type: "text", text: "The user didn't provide any content, please continue" }
			}
			return item
		})
	}

	private async handleWaitingForUser() {
		this.ask("resume_task", {
			question: "Do you want to continue with the task?",
		}).then((res) => {
			if (res.response === "yesButtonTapped") {
				this.state = TaskState.WAITING_FOR_API
				this.resetState()
				this.currentUserContent = [
					{
						type: "text",
						text: "Let's continue with the task, from where we left off.",
					},
				]
				this.newMessage(this.currentUserContent)
			}
			if (res.response === "noButtonTapped") {
				this.state = TaskState.COMPLETED
			}
			if (res.response === "messageResponse") {
				let textBlock: Anthropic.TextBlockParam = {
					type: "text",
					text: res.text ?? "",
				}
				let imageBlocks: Anthropic.ImageBlockParam[] = formatImagesIntoBlocks(res.images)
				if (textBlock.text.trim() === "" && imageBlocks.length > 1) {
					textBlock.text =
						"Please check the images below for more information and continue the task from where we left off."
				}
				if (textBlock.text.trim() === "") {
					textBlock.text = "Please continue the task from where we left off."
				}
				this.resetState()
				this.newMessage([textBlock, ...imageBlocks])
			}
		})
	}
}
