import React, { useEffect, useRef } from "react"
import { useEvent } from "react-use"
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai"
import { ClaudeMessage, ExtensionMessage } from "extension/shared/messages/extension-message"
import { vscode } from "../utils/vscode"
import { HistoryItem } from "extension/shared/history-item"
import type { GlobalState } from "extension/providers/state/global-state-manager"
import { useState } from "react"

// Define atoms for each piece of state

const commandTimeoutAtom = atom<number | undefined>(undefined)
commandTimeoutAtom.debugLabel = "commandTimeout"

const versionAtom = atom("")
versionAtom.debugLabel = "version"
const claudeMessagesAtom = atom<ClaudeMessage[]>([])
claudeMessagesAtom.debugLabel = "claudeMessages"
const taskHistoryAtom = atom<HistoryItem[]>([])
taskHistoryAtom.debugLabel = "taskHistory"
const customInstructionsAtom = atom<string | undefined>(undefined)
customInstructionsAtom.debugLabel = "customInstructions"
const alwaysAllowReadOnlyAtom = atom(false)
alwaysAllowReadOnlyAtom.debugLabel = "alwaysAllowReadOnly"
const alwaysAllowApproveOnlyAtom = atom(false)
alwaysAllowApproveOnlyAtom.debugLabel = "alwaysAllowApproveOnly"
const userAtom = atom<GlobalState["user"]>(undefined)
userAtom.debugLabel = "user"
const uriSchemeAtom = atom<string | undefined>(undefined)
uriSchemeAtom.debugLabel = "uriScheme"
const themeNameAtom = atom<string | undefined>(undefined)
themeNameAtom.debugLabel = "themeName"
const extensionNameAtom = atom<string | undefined>(undefined)
extensionNameAtom.debugLabel = "extensionName"

const currentTaskIdAtom = atom<string | undefined>(undefined)
currentTaskIdAtom.debugLabel = "currentTask"
const autoCloseTerminalAtom = atom(false)
autoCloseTerminalAtom.debugLabel = "autoCloseTerminal"
const gitHandlerEnabledAtom = atom(true)
gitHandlerEnabledAtom.debugLabel = "gitHandlerEnabled"
const gitCommitterTypeAtom = atom<"kodu" | "user">("kodu")
gitCommitterTypeAtom.debugLabel = "gitCommitterType"
const skipWriteAnimationAtom = atom(false)
skipWriteAnimationAtom.debugLabel = "skipWriteAnimation"
const lastShownAnnouncementIdAtom = atom<string | undefined>(undefined)
lastShownAnnouncementIdAtom.debugLabel = "lastShownAnnouncementId"
const inlineEditModeTypeAtom = atom<"full" | "diff">("full")
inlineEditModeTypeAtom.debugLabel = "inlineEditModeType"
const currentTaskAtom = atom<HistoryItem | undefined>((get) => {
	const currentTaskId = get(currentTaskIdAtom)
	return get(taskHistoryAtom).find((task) => task.id === currentTaskId)
})

// Derived atom for the entire state
export const extensionStateAtom = atom((get) => ({
	version: get(versionAtom),
	gitHandlerEnabled: get(gitHandlerEnabledAtom),
	gitCommitterType: get(gitCommitterTypeAtom),
	commandTimeout: get(commandTimeoutAtom),
	terminalCompressionThreshold: get(terminalCompressionThresholdAtom),
	claudeMessages: get(claudeMessagesAtom),
	lastShownAnnouncementId: get(lastShownAnnouncementIdAtom),
	taskHistory: get(taskHistoryAtom),
	currentContextWindow: get(currentContextWindowAtom),
	autoSummarize: get(autoSummarizeAtom),
	currentContextTokens: get(currentContextTokensAtom),
	currentTask: get(currentTaskAtom),
	currentTaskId: get(currentTaskIdAtom),
	inlineEditModeType: get(inlineEditModeTypeAtom),
	uriScheme: get(uriSchemeAtom),
	customInstructions: get(customInstructionsAtom),
	skipWriteAnimation: get(skipWriteAnimationAtom),
	alwaysAllowReadOnly: get(alwaysAllowReadOnlyAtom),
	autoCloseTerminal: get(autoCloseTerminalAtom),
	extensionName: get(extensionNameAtom),
	apiConfig: get(apiConfigAtom),
	themeName: get(themeNameAtom),
	user: get(userAtom),
	alwaysAllowWriteOnly: get(alwaysAllowApproveOnlyAtom),
}))
extensionStateAtom.debugLabel = "extensionState"

// Atom to track if state has been hydrated
const didHydrateStateAtom = atom(false)
didHydrateStateAtom.debugLabel = "didHydrateState"

export const showSettingsAtom = atom(false)
showSettingsAtom.debugLabel = "showSettings"

export const showHistoryAtom = atom(false)
showHistoryAtom.debugLabel = "showHistory"

export const showPromptEditorAtom = atom(false)
showPromptEditorAtom.debugLabel = "showPromptEditor"

const currentContextTokensAtom = atom(0)
currentContextTokensAtom.debugLabel = "currentContextTokens"

const currentContextWindowAtom = atom(0)
currentContextWindowAtom.debugLabel = "currentContextWindow"

const autoSummarizeAtom = atom(false)
autoSummarizeAtom.debugLabel = "autoSummarize"

const terminalCompressionThresholdAtom = atom<number | undefined>(undefined)
terminalCompressionThresholdAtom.debugLabel = "terminalCompressionThreshold"

const apiConfigAtom = atom<GlobalState["apiConfig"] | undefined>(undefined)
apiConfigAtom.debugLabel = "apiConfig"

const useHandleClaudeMessages = () => {
	const setClaudeMessages = useSetAtom(claudeMessagesAtom)

	const handleMessage = (event: MessageEvent) => {
		const message: ExtensionMessage = event.data

		if (message.type === "claudeMessages") {
			if (!message.taskId) {
				// return empty array if message is undefined
				setClaudeMessages([])
				return
			}
			setClaudeMessages(message.claudeMessages)
		}

		if (message.type === "claudeMessage") {
			// find the message in the current state and update it if not found add it
			setClaudeMessages((currentMessages) => {
				if (!message.claudeMessage || !message.taskId) {
					// return empty array if message is undefined
					return []
				}
				const index = currentMessages.findIndex((m) => m.ts === message.claudeMessage!.ts)

				if (index !== -1) {
					if (message.claudeMessage.ask === "tool") {
						console.log(`Received tool update at ${Date.now()} for :\n`, {
							toolStatus: message.claudeMessage.status,
							toolName: JSON.parse(message.claudeMessage.text || "{}").tool,
						})
					}
					const messages = [...currentMessages]
					messages[index] = message.claudeMessage
					return messages
				}
				return [...currentMessages, message.claudeMessage]
			})
		}
	}

	useEvent("message", handleMessage)
}

export const ExtensionStateProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	useHandleClaudeMessages()
	const setVersion = useSetAtom(versionAtom)
	const setClaudeMessages = useSetAtom(claudeMessagesAtom)
	const setCommandTimeout = useSetAtom(commandTimeoutAtom)
	const setTaskHistory = useSetAtom(taskHistoryAtom)
	const setGitHandlerEnabled = useSetAtom(gitHandlerEnabledAtom)
	const setGitCommitterType = useSetAtom(gitCommitterTypeAtom)
	const setApiConfig = useSetAtom(apiConfigAtom)
	const setCustomInstructions = useSetAtom(customInstructionsAtom)
	const setAlwaysAllowReadOnly = useSetAtom(alwaysAllowReadOnlyAtom)
	const setAutoSummarize = useSetAtom(autoSummarizeAtom)
	const setUser = useSetAtom(userAtom)
	const setLastShownAnnouncementId = useSetAtom(lastShownAnnouncementIdAtom)
	const setSkipWriteAnimation = useSetAtom(skipWriteAnimationAtom)
	const setThemeName = useSetAtom(themeNameAtom)
	const setCurrentIdTask = useSetAtom(currentTaskIdAtom)
	const setAutoCloseTerminal = useSetAtom(autoCloseTerminalAtom)
	const setUriScheme = useSetAtom(uriSchemeAtom)
	const setCurrentContextWindow = useSetAtom(currentContextWindowAtom)
	const setDidHydrateState = useSetAtom(didHydrateStateAtom)
	const setCurrentContextTokens = useSetAtom(currentContextTokensAtom)
	const setAlwaysAllowWriteOnly = useSetAtom(alwaysAllowApproveOnlyAtom)
	const setExtensionName = useSetAtom(extensionNameAtom)
	const setTerminalCompressionThreshold = useSetAtom(terminalCompressionThresholdAtom)
	const setInlineEditModeType = useSetAtom(inlineEditModeTypeAtom)

	const handleMessage = (event: MessageEvent) => {
		const message: ExtensionMessage = event.data

		if (message.type === "state" && message.state) {
			setVersion(message.state.version)
			setCurrentIdTask(message.state.currentTaskId)
			if (!message.state.currentTaskId) {
				setClaudeMessages([])
			}
			setCommandTimeout(message.state.commandTimeout)
			setApiConfig(message.state.apiConfig)
			setGitCommitterType(message.state.gitCommitterType ?? "kodu")
			setTerminalCompressionThreshold(message.state.terminalCompressionThreshold)
			setAutoSummarize(!!message.state.autoSummarize)
			setInlineEditModeType(message.state.inlineEditOutputType ?? "full")
			setLastShownAnnouncementId(message.state.lastShownAnnouncementId)
			setTaskHistory(message.state.taskHistory)
			setCurrentContextTokens(message.state.currentContextTokens)
			setAutoCloseTerminal(!!message.state.autoCloseTerminal)
			setGitHandlerEnabled(message.state.gitHandlerEnabled ?? true)
			setUser(message.state.user)
			setExtensionName(message.state.extensionName)
			setCustomInstructions(message.state.customInstructions)
			setAlwaysAllowReadOnly(!!message.state.alwaysAllowReadOnly)
			setCurrentContextWindow(message.state.currentContextWindow)
			setAutoCloseTerminal(!!message.state.autoCloseTerminal)
			setUser(message.state.user)
			setExtensionName(message.state.extensionName)
			setSkipWriteAnimation(!!message.state.skipWriteAnimation)
			setAlwaysAllowWriteOnly(!!message.state.alwaysAllowWriteOnly)
			setDidHydrateState(true)
			setThemeName(message.state.themeName)
			setUriScheme(message.state.uriScheme)
		}
		if (message.type === "action" && message.action === "koduCreditsFetched") {
			setUser(message.user)
		}
	}

	useEvent("message", handleMessage)

	useEffect(() => {
		vscode.postMessage({ type: "webviewDidLaunch" })
	}, [])

	const [didHydrateState] = useAtom(didHydrateStateAtom)

	if (!didHydrateState) {
		return null
	}

	return <>{children}</>
}

export const useExtensionState = () => {
	const [state] = useAtom(extensionStateAtom)
	const setCustomInstructions = useSetAtom(customInstructionsAtom)
	const setLastShownAnnouncementId = useSetAtom(lastShownAnnouncementIdAtom)
	const setTerminalCompressionThreshold = useSetAtom(terminalCompressionThresholdAtom)
	const setAlwaysAllowReadOnly = useSetAtom(alwaysAllowReadOnlyAtom)
	const setCommandTimeout = useSetAtom(commandTimeoutAtom)
	const setAlwaysAllowWriteOnly = useSetAtom(alwaysAllowApproveOnlyAtom)
	const setInlineEditModeType = useSetAtom(inlineEditModeTypeAtom)
	const setApiConfig = useSetAtom(apiConfigAtom)

	const setSkipWriteAnimation = useSetAtom(skipWriteAnimationAtom)
	const setAutoSummarize = useSetAtom(autoSummarizeAtom)
	const setAutoCloseTerminal = useSetAtom(autoCloseTerminalAtom)
	const setGitHandlerEnabled = useSetAtom(gitHandlerEnabledAtom)

	return {
		...state,
		setApiConfig,
		setLastShownAnnouncementId,
		setTerminalCompressionThreshold,
		setGitCommitterType: useSetAtom(gitCommitterTypeAtom),
		setSkipWriteAnimation,
		setCommandTimeout,
		setAutoCloseTerminal,
		setCustomInstructions,
		setAlwaysAllowWriteOnly,
		setInlineEditModeType,
		setAutoSummarize,

		setAlwaysAllowReadOnly,

		setGitHandlerEnabled,
	}
}
