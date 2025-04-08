import { ApiManager } from "../../../api/api-handler"
import { ExtensionProvider } from "../../../providers/extension-provider"
import { amplitudeTracker } from "../../../utils/amplitude"
import { KoduAgentState, MainAgentOptions, FileVersion, SubAgentState } from "../types"
import { ApiHistoryManager } from "./api-history-manager"
import { ClaudeMessagesManager } from "./claude-messages-manager"
import { IOManager } from "./io-manager"
import { SubAgentManager } from "./sub-agent-manager"

export class StateManager {
	private _state: KoduAgentState
	private _apiManager: ApiManager
	private _providerRef: WeakRef<ExtensionProvider>
	private _alwaysAllowReadOnly: boolean
	private _customInstructions?: string
	private _alwaysAllowWriteOnly: boolean
	private _terminalCompressionThreshold?: number
	private _autoCloseTerminal?: boolean
	private _skipWriteAnimation?: boolean
	private _autoSummarize?: boolean
	private _temporayPauseAutomaticMode: boolean = false
	private _inlineEditOutputType?: "full" | "diff" = "full"
	private _gitHandlerEnabled: boolean = false
	private _ioManager: IOManager
	private _subAgentManager: SubAgentManager

	public claudeMessagesManager: ClaudeMessagesManager
	public apiHistoryManager: ApiHistoryManager

	constructor(options: MainAgentOptions, apiManager: ApiManager) {
		const provider = options.provider
		this._providerRef = new WeakRef(provider)

		const globalStoragePath = this._providerRef.deref()?.context.globalStorageUri.fsPath
		if (!globalStoragePath) {
			throw new Error("Global storage uri is invalid")
		}

		const taskId = options.historyItem?.id ?? Date.now().toString()

		this._ioManager = new IOManager({
			fsPath: globalStoragePath,
			taskId: taskId,
		})

		this._apiManager = apiManager

		this._alwaysAllowReadOnly = options.alwaysAllowReadOnly ?? false
		this._alwaysAllowWriteOnly = options.alwaysAllowWriteOnly ?? false
		this._customInstructions = options.customInstructions
		this._terminalCompressionThreshold = options.terminalCompressionThreshold
		this._gitHandlerEnabled = options.gitHandlerEnabled ?? false

		if (["full", "diff"].includes(options.inlineEditOutputType ?? "")) {
			this._inlineEditOutputType = options.inlineEditOutputType
		} else {
			this._inlineEditOutputType = "full"
			provider.getGlobalStateManager().updateGlobalState("inlineEditOutputType", "full")
		}

		this._autoCloseTerminal = options.autoCloseTerminal
		this._skipWriteAnimation = options.skipWriteAnimation
		this._autoSummarize = options.autoSummarize

		// Initialize arrays and objects so they're always defined and stable
		this._state = {
			taskId: taskId,
			apiConversationHistory: [],
			claudeMessages: [],
			historyErrors: {}, // ensure it's always an object
		}

		this.claudeMessagesManager = new ClaudeMessagesManager({
			state: this._state,
			ioManager: this._ioManager,
			providerRef: this._providerRef,
			stateManager: this,
		})

		this.apiHistoryManager = new ApiHistoryManager({
			state: this._state,
			ioManager: this._ioManager,
		})

		this._subAgentManager = new SubAgentManager({
			subAgentId: options.historyItem?.currentSubAgentId,
			ioManager: this._ioManager,
			onEnterSucessful: this.onEnterSuccesfulSubAgent.bind(this),
			onExit: this.onExitSubAgent.bind(this),
		})
	}

	get state(): KoduAgentState {
		return this._state
	}

	get ioManager(): IOManager {
		return this._ioManager
	}

	get subAgentManager(): SubAgentManager {
		return this._subAgentManager
	}

	get autoCloseTerminal(): boolean | undefined {
		return this._autoCloseTerminal
	}

	get customInstructions(): string | undefined {
		return this._customInstructions
	}

	get taskId(): string {
		return this._state.taskId
	}

	get temporayPauseAutomaticMode(): boolean {
		return this._temporayPauseAutomaticMode
	}

	get apiManager(): ApiManager {
		return this._apiManager
	}

	get terminalCompressionThreshold(): number | undefined {
		return this._terminalCompressionThreshold
	}
	set terminalCompressionThreshold(newValue: number | undefined) {
		this._terminalCompressionThreshold = newValue
	}

	get autoSummarize(): boolean | undefined {
		return this._autoSummarize
	}

	get providerRef(): WeakRef<ExtensionProvider> {
		return this._providerRef
	}

	get alwaysAllowReadOnly(): boolean {
		return this._alwaysAllowReadOnly
	}

	get alwaysAllowWriteOnly(): boolean {
		return this._alwaysAllowWriteOnly
	}

	get inlineEditOutputType(): "full" | "diff" | undefined {
		return this._inlineEditOutputType
	}

	get skipWriteAnimation(): boolean | undefined {
		return this._skipWriteAnimation
	}

	get gitHandlerEnabled(): boolean {
		return this._gitHandlerEnabled
	}

	/**
	 * Instead of replacing _state entirely, we merge properties into the existing
	 * _state object to keep all references stable.
	 */
	public setState(newState: KoduAgentState): void {
		// Copy primitive values
		this._state.taskId = newState.taskId

		// Copy arrays by clearing and pushing
		this._state.apiConversationHistory.length = 0
		if (newState.apiConversationHistory) {
			this._state.apiConversationHistory.push(...newState.apiConversationHistory)
		}

		this._state.claudeMessages.length = 0
		if (newState.claudeMessages) {
			this._state.claudeMessages.push(...newState.claudeMessages)
		}

		// Copy historyErrors (an object)
		if (newState.historyErrors) {
			for (const key in newState.historyErrors) {
				this._state.historyErrors[key] = newState.historyErrors[key]
			}
		}
	}

	public setSkipWriteAnimation(newValue: boolean | undefined) {
		this._skipWriteAnimation = newValue
	}

	public setGitHandlerEnabled(newValue: boolean): void {
		this._gitHandlerEnabled = newValue
		this._state.gitHandlerEnabled = newValue
	}

	get historyErrors(): KoduAgentState["historyErrors"] | undefined {
		return this._state.historyErrors
	}

	set historyErrors(newErrors: KoduAgentState["historyErrors"]) {
		if (newErrors) {
			for (const key in newErrors) {
				this._state.historyErrors[key] = newErrors[key]
			}
		}
	}

	public setHistoryErrorsEntry(key: string, value: NonNullable<KoduAgentState["historyErrors"]>[string]): void {
		this._state.historyErrors[key] = value
	}

	public setAutoSummarize(newValue: boolean): void {
		this._autoSummarize = newValue
	}

	public setAutoCloseTerminal(newValue: boolean): void {
		this._autoCloseTerminal = newValue
	}

	public setTerminalCompressionThresholdValue(newValue?: number): void {
		this._terminalCompressionThreshold = newValue
	}

	public setApiManager(newApiManager: ApiManager): void {
		this._apiManager = newApiManager
	}

	public setProviderRef(newProviderRef: WeakRef<ExtensionProvider>): void {
		this._providerRef = newProviderRef
	}

	public setCustomInstructions(newInstructions?: string): void {
		this._customInstructions = newInstructions
	}

	public setAlwaysAllowReadOnly(newValue: boolean): void {
		this._alwaysAllowReadOnly = newValue
		this.updateAmplitudeSettings()
	}

	public setInlineEditOutputType(newValue?: "full" | "diff"): void {
		this._inlineEditOutputType = newValue
	}

	private updateAmplitudeSettings() {
		amplitudeTracker.updateUserSettings({
			AlwaysAllowReads: this.alwaysAllowReadOnly,
			AutomaticMode: this.alwaysAllowWriteOnly,
			AutoSummarize: this.autoSummarize,
		})
	}

	private async onEnterSuccesfulSubAgent(subAgentState: SubAgentState): Promise<void> {
		// load apiConversationHistory from the subAgent
		await this.apiHistoryManager.getSavedApiConversationHistory(true)
		// replace the subAgentState with the new one
		this.providerRef.deref()?.getStateManager().updateTaskHistory({
			id: this._state.taskId,
			currentSubAgentId: subAgentState.ts,
		})
	}

	private async onExitSubAgent(): Promise<void> {
		// Now load the main agent's history
		await this.apiHistoryManager.getSavedApiConversationHistory(true)

		this.providerRef.deref()?.getStateManager().updateTaskHistory({
			id: this._state.taskId,
			currentSubAgentId: undefined,
		})
	}

	public setAlwaysAllowWriteOnly(newValue: boolean): void {
		this._alwaysAllowWriteOnly = newValue
		this.updateAmplitudeSettings()
	}

	public addErrorPath(errorPath: string): void {
		this._state.historyErrors[errorPath] = {
			lastCheckedAt: -1,
			error: "",
		}
	}

	public async setTemporaryPauseAutomaticMode(newValue: boolean): Promise<void> {
		this._temporayPauseAutomaticMode = newValue
	}

	public setTerminalCompressionThreshold(newValue?: number): void {
		this._terminalCompressionThreshold = newValue
	}

	// Delegating version file operations to IOManager now
	public async saveFileVersion(file: FileVersion): Promise<void> {
		await this._ioManager.saveFileVersion(file)
	}

	public async deleteFileVersion(file: FileVersion): Promise<void> {
		await this._ioManager.deleteFileVersion(file)
	}

	public async getFileVersions(relPath: string): Promise<FileVersion[]> {
		return await this._ioManager.getFileVersions(relPath)
	}

	public async getFilesInTaskDirectory(): Promise<Record<string, FileVersion[]>> {
		return await this._ioManager.getFilesInTaskDirectory()
	}
}
