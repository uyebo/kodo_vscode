import React, { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import { ChatState, ChatViewProps } from "./chat"
import { isV1ClaudeMessage } from "extension/shared/messages/extension-message"
import { useAtom } from "jotai"
import { attachmentsAtom, chatStateAtom, syntaxHighlighterAtom } from "./atoms"
import { useExtensionState } from "@/context/extension-state-context"
import { CollapseProvider } from "@/context/collapse-state-context"
import { useChatMessageHandling } from "@/hooks/use-message-handler"
import { useImageHandling } from "@/hooks/use-image-handler"
import { useMessageRunning } from "@/hooks/use-message-running"
import { useSelectImages } from "@/hooks/use-select-images"
import { getSyntaxHighlighterStyleFromTheme } from "@/utils/get-syntax-highlighter-style-from-theme"
import { vscode } from "@/utils/vscode"
import { ChatInput } from "./chat-input"
import ButtonSection from "./button-section"
import ChatScreen from "./chat-screen"
import HistoryPreview from "../history-preview/history-preview"
import ChatMessages from "./chat-messages"
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism"
import TaskHeader from "../task-header/task-header"
import { Button } from "../ui/button"
import { AlertCircle } from "lucide-react"
import AnnouncementBanner from "../announcement-banner"

const ChatView: React.FC<ChatViewProps> = ({
	isHidden,
	selectedModelSupportsImages,
	selectedModelSupportsPromptCache,
	showHistoryView,
}) => {
	const [state, setState] = useAtom(chatStateAtom)
	const [isMaxContextReached, setIsMaxContextReached] = useState(false)

	const updateState = useCallback(
		(updates: Partial<ChatState>) => {
			setState((prev) => ({ ...prev, ...updates }))
		},
		[setState]
	)

	// Use the useSelectImages hook to handle image selection
	useSelectImages()

	const [attachments, setAttachments] = useAtom(attachmentsAtom)
	const [syntaxHighlighterStyle, setSyntaxHighlighterStyle] = useAtom(syntaxHighlighterAtom)

	const { claudeMessages: messages, themeName: vscodeThemeName, uriScheme, user, currentTask } = useExtensionState()

	const [isPending, startTransition] = useTransition()

	const handleClaudeAskResponse = useCallback(
		(text: string) => {
			// reset the of the buttons
			updateState({
				primaryButtonText: undefined,
				secondaryButtonText: undefined,
				enableButtons: false,
			})
			vscode.postMessage({
				type: "askResponse",
				askResponse: "messageResponse",
				text,
				images: state.selectedImages,
			})
		},
		[state.selectedImages, updateState]
	)

	const updateButtonState = useCallback((updates: Partial<ChatState>) => {
		setState((prev) => {
			const shouldUpdate =
				prev.enableButtons !== updates.enableButtons ||
				prev.primaryButtonText !== updates.primaryButtonText ||
				prev.secondaryButtonText !== updates.secondaryButtonText ||
				prev.claudeAsk !== updates.claudeAsk ||
				prev.textAreaDisabled !== updates.textAreaDisabled

			if (!shouldUpdate) return prev
			return { ...prev, ...updates }
		})
	}, [])

	const handleButtonStateUpdate = useCallback(
		(updates: Partial<ChatState>) => {
			startTransition(() => {
				if (
					"enableButtons" in updates ||
					"primaryButtonText" in updates ||
					"secondaryButtonText" in updates ||
					"claudeAsk" in updates ||
					"textAreaDisabled" in updates
				) {
					updateButtonState(updates)
				} else {
					setState((prev) => ({ ...prev, ...updates }))
				}
			})
		},
		[updateButtonState]
	)

	const { shouldDisableImages, handlePaste } = useImageHandling(selectedModelSupportsImages, state, updateState)

	const firstTaskMsg = useMemo(() => messages.at(0), [messages])
	const cleanedMessages = useMemo(() => messages.slice(1), [messages])

	const elapsedTime = useMemo(() => {
		if (!firstTaskMsg) return undefined
		return messages.reduce((acc, msg) => {
			if (isV1ClaudeMessage(msg) && msg.completedAt) {
				return acc + msg.completedAt - msg.ts
			}
			return acc
		}, 0)
	}, [messages, firstTaskMsg])

	const isMessageRunning = useMessageRunning(messages)

	useEffect(() => {
		if (!currentTask?.ts) {
			updateState({
				inputValue: "",
				textAreaDisabled: false,
				selectedImages: [],
				claudeAsk: undefined,
				enableButtons: false,
				primaryButtonText: undefined,
				secondaryButtonText: undefined,
			})
		}
	}, [currentTask?.ts])

	useChatMessageHandling(cleanedMessages, handleButtonStateUpdate, setAttachments)

	const visibleMessages = useMemo(() => {
		return cleanedMessages.filter((message) => {
			if (message.say === "shell_integration_warning") {
				return true
			}
			if (
				message.ask === "tool" &&
				(message.text === "" || message.text === "{}" || !message.text?.includes('tool":'))
			) {
				return false
			}
			if (
				(message.ask === "completion_result" && message.text === "") ||
				["resume_task", "resume_completed_task"].includes(message.ask!)
			) {
				return false
			}
			if (["api_req_finished", "api_req_retried"].includes(message.say!)) {
				return false
			}
			if (message.say === "api_req_started") return true
			if (message.say === "text" && (message.text ?? "") === "" && (message.images?.length ?? 0) === 0) {
				return false
			}
			return true
		})
	}, [cleanedMessages])

	useEffect(() => {
		const hasMaxContext = visibleMessages.some(
			(msg) => msg.say === "chat_finished" || (msg.ask === "tool" && msg.text?.includes('"tool":"chat_finished"'))
		)
		setIsMaxContextReached(hasMaxContext)
	}, [visibleMessages])

	useEffect(() => {
		if (!vscodeThemeName) return
		const theme = getSyntaxHighlighterStyleFromTheme(vscodeThemeName)
		if (theme) {
			setSyntaxHighlighterStyle(theme)
		}
	}, [vscodeThemeName])

	const handleSendMessage = useCallback(
		(input?: string) => {
			let text = state.inputValue?.trim()
			if (!!input && input.length > 1) {
				text = input?.trim()
			}

			if (text || state.selectedImages.length > 0) {
				if (!currentTask) {
					vscode.postMessage({
						type: "newTask",
						text,
						images: state.selectedImages,
						attachements: attachments,
					})
				} else if (state.claudeAsk) {
					handleClaudeAskResponse(text)
				} else {
					vscode.postMessage({
						type: "askResponse",
						askResponse: "messageResponse",
						text,
						images: state.selectedImages,
						attachements: attachments,
					})
				}
				updateState({
					inputValue: "",
					textAreaDisabled: true,
					selectedImages: [],
					claudeAsk: undefined,
					enableButtons: false,
					primaryButtonText: undefined,
					secondaryButtonText: undefined,
					prevInputValue: state.inputValue,
					prevImages: state.selectedImages,
				})
				setAttachments([])
			}
		},
		[
			state.inputValue,
			state.selectedImages,
			state.claudeAsk,
			messages.length,
			updateState,
			setAttachments,
			attachments,
			handleClaudeAskResponse,
		]
	)

	const handlePrimaryButtonClick = useCallback(() => {
		switch (state.claudeAsk) {
			case "api_req_failed":
			case "request_limit_reached":
			case "command":
			case "command_output":
			case "tool":
			case "resume_task":
				setTimeout(() => {
					vscode.postMessage({
						type: "askResponse",
						askResponse: "yesButtonTapped",
						text: "Let's resume the task from where we left off",
					})
				}, 100)
				if (state.claudeAsk === "tool") {
					return
				}
				break
			case "completion_result":
			case "resume_completed_task":
				vscode.postMessage({ type: "clearTask" })
				break
		}
		updateState({
			textAreaDisabled: true,
			claudeAsk: undefined,
			primaryButtonText: undefined,
			secondaryButtonText: undefined,
			enableButtons: false,
		})
	}, [state.claudeAsk, updateState])

	const handleSecondaryButtonClick = useCallback(() => {
		switch (state.claudeAsk) {
			case "request_limit_reached":
			case "api_req_failed":
				vscode.postMessage({ type: "clearTask" })
				break
			case "command":
			case "tool":
				vscode.postMessage({ type: "askResponse", askResponse: "noButtonTapped" })
				break
		}
		updateState({
			textAreaDisabled: true,
			claudeAsk: undefined,
			primaryButtonText: undefined,
			secondaryButtonText: undefined,
			enableButtons: false,
		})
	}, [state.claudeAsk, updateState])

	return (
		<div
			className={`h-full chat-container ${isHidden ? "hidden" : ""}`}
			style={{
				display: isHidden ? "none" : "flex",
				flexDirection: "column",
				overflow: "hidden",
			}}>
			<div
				className="chat-content relative"
				style={{
					borderTop: "1px solid var(--section-border)",
					flex: "1 1 0%",
					display: "flex",
					flexDirection: "column",
					overflowY: "auto",
				}}>
				<AnnouncementBanner />
				{!!currentTask && firstTaskMsg ? (
					<>
						<CollapseProvider>
							<TaskHeader
								key={`header-${firstTaskMsg.ts}`}
								firstMsg={firstTaskMsg}
								tokensIn={currentTask.tokensIn}
								tokensOut={currentTask.tokensOut}
								elapsedTime={elapsedTime}
								doesModelSupportPromptCache={selectedModelSupportsPromptCache}
								cacheWrites={currentTask.cacheWrites}
								cacheReads={currentTask.cacheReads}
								totalCost={currentTask.totalCost}
								onClose={() => vscode.postMessage({ type: "clearTask" })}
								isHidden={isHidden}
								lastMessageAt={currentTask.ts}
								koduCredits={user?.credits ?? 0}
								vscodeUriScheme={uriScheme}
							/>
							<ChatMessages
								key={`messages-${firstTaskMsg.ts}`}
								taskId={firstTaskMsg.ts}
								visibleMessages={visibleMessages}
								syntaxHighlighterStyle={syntaxHighlighterStyle}
							/>
						</CollapseProvider>
					</>
				) : (
					<>
						<ChatScreen
							taskHistory={<HistoryPreview showHistoryView={showHistoryView} />}
							handleClick={handleSendMessage}
						/>
					</>
				)}
			</div>
			{!isMaxContextReached && (
				<div className="mb-0 mt-auto">
					{!!currentTask && (
						<ButtonSection
							primaryButtonText={state.primaryButtonText}
							secondaryButtonText={state.secondaryButtonText}
							enableButtons={state.enableButtons}
							isRequestRunning={isMessageRunning}
							handlePrimaryButtonClick={handlePrimaryButtonClick}
							handleSecondaryButtonClick={handleSecondaryButtonClick}
						/>
					)}

					<ChatInput
						state={state}
						updateState={updateState}
						onSendMessage={handleSendMessage}
						shouldDisableImages={shouldDisableImages}
						handlePaste={handlePaste}
						isRequestRunning={isMessageRunning}
						isInTask={!!currentTask}
						isHidden={isHidden}
					/>
				</div>
			)}
			{isMaxContextReached && (
				<div className="sticky bottom-0 w-full bg-destructive/10 border-t border-destructive/20 p-4 flex flex-col gap-4">
					<div className="flex flex-col gap-1">
						<div className="flex items-center gap-2">
							<AlertCircle className="h-4 w-4 text-destructive" />
							<span className="text-sm font-bold">Maximum context limit reached</span>
						</div>
						<span className="text-sm">
							The conversation has reached its context window limit and cannot continue further. To
							proceed, you'll need to start a new task. Don't worry - Kodu will still have access to your
							project's files and structure in the new task.
						</span>
					</div>
					<div className="flex justify-end">
						<Button variant="default" onClick={() => vscode.postMessage({ type: "clearTask" })}>
							Start New Task
						</Button>
					</div>
				</div>
			)}
		</div>
	)
}

export default React.memo(ChatView, (prevProps, nextProps) => {
	return (
		prevProps.isHidden === nextProps.isHidden &&
		prevProps.selectedModelSupportsImages === nextProps.selectedModelSupportsImages &&
		prevProps.selectedModelSupportsPromptCache === nextProps.selectedModelSupportsPromptCache
	)
})
