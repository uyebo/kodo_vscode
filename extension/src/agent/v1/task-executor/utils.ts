import {
	ClaudeAsk,
	ClaudeSay,
	ClaudeMessage,
	ToolStatus,
	V1ClaudeMessage,
	isV1ClaudeMessage,
} from "../../../shared/messages/extension-message"
import { ClaudeAskResponse } from "../../../shared/messages/client-message"
import { StateManager } from "../state-manager"
import { ExtensionProvider } from "../../../providers/extension-provider"
import { ChatTool } from "../../../shared/new-tools"
import { AskManager } from "./ask-manager"
import { merge } from "lodash"
import { DeepPartial } from "ai"

export enum TaskState {
	IDLE = "IDLE",
	WAITING_FOR_API = "WAITING_FOR_API",
	PROCESSING_RESPONSE = "PROCESSING_RESPONSE",
	EXECUTING_TOOL = "EXECUTING_TOOL",
	WAITING_FOR_USER = "WAITING_FOR_USER",
	COMPLETED = "COMPLETED",
	ABORTED = "ABORTED",
}

export class TaskError extends Error {
	type:
		| "API_ERROR"
		| "TOOL_ERROR"
		| "USER_ABORT"
		| "UNKNOWN_ERROR"
		| "UNAUTHORIZED"
		| "PAYMENT_REQUIRED"
		| "NETWORK_ERROR"
	constructor({
		type,
		message,
	}: {
		type:
			| "API_ERROR"
			| "TOOL_ERROR"
			| "USER_ABORT"
			| "UNKNOWN_ERROR"
			| "UNAUTHORIZED"
			| "PAYMENT_REQUIRED"
			| "NETWORK_ERROR"
		message: string
	}) {
		super(message)
		this.type = type
	}
}

export interface AskResponse {
	response: ClaudeAskResponse
	text?: string
	images?: string[]
}

export type AskDetails = {
	question?: string
	tool?: ChatTool
}

export abstract class TaskExecutorUtils {
	protected stateManager: StateManager
	protected providerRef: WeakRef<ExtensionProvider>
	public askManager: AskManager

	constructor(stateManager: StateManager, providerRef: WeakRef<ExtensionProvider>) {
		this.stateManager = stateManager
		this.providerRef = providerRef
		this.askManager = new AskManager(stateManager)
	}

	// Abstract methods that must be implemented by derived classes

	public async handleAskResponse(response: ClaudeAskResponse, text?: string, images?: string[]): Promise<void> {
		const messages = await this.stateManager.claudeMessagesManager.getSavedClaudeMessages()
		const lastAskMessage = [...messages].reverse().find((msg) => msg.type === "ask")
		if (lastAskMessage) {
			this.askManager.handleResponse(lastAskMessage.ts, response, text, images)
		}
	}
	public async ask(...args: Parameters<AskManager["ask"]>): Promise<AskResponse> {
		return await this.askManager.ask(...args)
	}

	public async partialUpdateTool(data: Partial<ChatTool>, askTs: number): Promise<void> {
		const { tool } = data
		// check if there is an existing ask message with the same ts if not create a new one
		const msg = this.stateManager.claudeMessagesManager.getMessageById(askTs)
		if (!msg || !isV1ClaudeMessage(msg)) {
			// if there is no message with the same ts we avoid updating
			return
		}
		try {
			const msgToolData = JSON.parse(msg.text ?? "") as ChatTool

			const mergedToolData = merge({}, msgToolData, data)

			const askMessageLatest = await this.stateManager.claudeMessagesManager.updateClaudeMessage(
				askTs,
				{
					...msg,
					text: JSON.stringify(mergedToolData),
				},
				true
			)
			if (!askMessageLatest) {
				return
			}
		} catch (err) {
			console.error(err)
		}
	}

	public async updateAsk(type: ClaudeAsk, data: AskDetails, askTs: number): Promise<void> {
		const { question, tool } = data
		// check if there is an existing ask message with the same ts if not create a new one
		const askMessage: V1ClaudeMessage = {
			ts: askTs,
			type: "ask",
			ask: type,
			text: question ? question : tool ? JSON.stringify(tool) : "",
			v: 1,
			status: tool?.approvalState,
			autoApproved: !!this.stateManager.alwaysAllowWriteOnly,
			modelId: this.getModelId(),
		}
		if (!this.stateManager.claudeMessagesManager.getMessageById(askTs)) {
			await this.stateManager.claudeMessagesManager.addToClaudeMessages(askMessage, true)

			return
		}

		const askMessageLatest = await this.stateManager.claudeMessagesManager.updateClaudeMessage(
			askTs,
			askMessage,
			true
		)
	}

	public async updateSayPartial(sayTs: number, data: DeepPartial<ClaudeMessage>): Promise<void> {
		const message = this.stateManager.claudeMessagesManager.getMessageById(sayTs)
		if (!message) {
			return
		}
		const deepMerged = merge({}, message, data)
		const updatedMessage = await this.stateManager.claudeMessagesManager.updateClaudeMessage(
			sayTs,
			deepMerged,
			true
		)
		if (!updatedMessage) {
			return
		}
	}

	public async sayWithId(
		sayTs: number,
		type: ClaudeSay,
		text?: string,
		images?: string[],
		overrides?: Partial<ClaudeMessage>
	): Promise<number> {
		const sayMessage: ClaudeMessage = {
			ts: sayTs,
			type: "say",
			say: type,
			text: text,
			images,
			isFetching: type === "api_req_started",
			v: 1,
			modelId: this.getModelId(),
			...overrides,
		}
		if (this.stateManager.claudeMessagesManager.getMessageById(sayTs)) {
			await this.stateManager.claudeMessagesManager.updateClaudeMessage(sayTs, sayMessage, true)
		} else {
			await this.stateManager.claudeMessagesManager.addToClaudeMessages(sayMessage, true)
		}

		return sayTs
	}

	public async sayHook({
		hookName,
		state,
		ts = Date.now(),
		output,
		input,
		apiMetrics,
		...rest
	}: {
		hookName: string
		state: "pending" | "completed" | "error"
		ts: number
		output: string
		input: string
		apiMetrics?: V1ClaudeMessage["apiMetrics"]
	} & Partial<V1ClaudeMessage>): Promise<number> {
		const sayMessage: ClaudeMessage = {
			ts,
			type: "say",
			say: "hook",
			hook: {
				name: hookName,
				state,
				output,
				input,
			},
			modelId: this.getModelId(),
			apiMetrics,
			v: 1,
			...rest,
		}
		if (this.stateManager.claudeMessagesManager.getMessageById(ts)) {
			await this.stateManager.claudeMessagesManager.updateClaudeMessage(ts, sayMessage, true)
		} else {
			await this.stateManager.claudeMessagesManager.addToClaudeMessages(sayMessage, true)
		}

		return ts
	}

	public async say(
		type: ClaudeSay,
		text?: string,
		images?: string[],
		sayTs = Date.now(),
		options: Partial<V1ClaudeMessage> = {}
	): Promise<number> {
		const sayMessage: ClaudeMessage = {
			ts: sayTs,
			type: "say",
			say: type,
			text: text,
			images,
			isFetching: type === "api_req_started",
			v: 1,
			...options,
			modelId: this.getModelId(),
		}

		await this.stateManager.claudeMessagesManager.addToClaudeMessages(sayMessage, true)

		return sayTs
	}

	private getModelId(): string {
		return this.stateManager.apiManager.getModelId()
	}

	protected logState(message: string): void {
		console.log(`[TaskExecutor] ${message} (State: ${this.getState()})`)
	}

	protected logError(error: Error): void {
		console.error(`[TaskExecutor] Error (State: ${this.getState()}):`, error)
	}

	protected abstract getState(): TaskState
}
