import * as path from "path"
import { DiffViewProvider } from "../../../../../integrations/editor/diff-view-provider"
import { ClaudeSayTool } from "../../../../../shared/messages/extension-message"
import { getCwd, getReadablePath, isTextBlock } from "../../../utils"
import { BaseAgentTool, FullToolParams } from "../../base-agent.tool"
import { AgentToolOptions } from "../../types"
import fs from "fs"
import { detectCodeOmission } from "./detect-code-omission"
import {
	checkFileExists,
	preprocessContent,
	EditBlock,
	DiffBlockManager,
	SEARCH_HEAD,
	SEPARATOR,
	REPLACE_HEAD,
} from "./utils"
import { InlineEditHandler } from "../../../../../integrations/editor/inline-editor"
import { ToolResponseV2 } from "../../../types"
import PQueue from "p-queue"

import { GitCommitResult } from "../../../handlers/git-handler"
import { createPatch } from "diff"
import { FileEditorToolParams } from "../../schema/file_editor_tool"
import { FileVersion } from "../../../types"
import dedent from "dedent"
import { formatFileToLines } from "../read-file/utils"
import diffFixerPrompt from "../../../prompts/agents/diff-fixer.prompt"
import * as vscode from "vscode"
import { unlink } from "fs/promises"
export class FileEditorTool extends BaseAgentTool<FileEditorToolParams> {
	public diffViewProvider: DiffViewProvider
	public inlineEditor: InlineEditHandler
	private isProcessingFinalContent: boolean = false
	private pQueue: PQueue = new PQueue({ concurrency: 1 })
	private skipWriteAnimation: boolean = false
	private fileState?: {
		absolutePath: string
		orignalContent: string
		isExistingFile: boolean
	}
	private diffBlockManager: DiffBlockManager
	private finalizedBlockIds: string[] = []

	constructor(params: FullToolParams<FileEditorToolParams>, options: AgentToolOptions) {
		super(params, options)
		this.diffViewProvider = new DiffViewProvider(getCwd())
		this.inlineEditor = new InlineEditHandler()
		this.diffBlockManager = new DiffBlockManager()
		if (!!this.koduDev.getStateManager().skipWriteAnimation) {
			this.skipWriteAnimation = true
		}
	}

	override async execute() {
		const mode = this.params.input.mode
		const relPath = this.params.input.path

		if (!relPath) {
			return this.toolResponse("error", "Missing required parameter 'path'")
		}

		switch (mode) {
			case "rollback":
				return this.handleRollback(relPath)
			case "edit":
			case "whole_write":
				return this.processFileWrite() // existing behavior
			default:
				throw new Error(`Unsupported mode: ${mode}`)
		}
	}

	private commitXMLGenerator(commitResult: GitCommitResult): string {
		return `
<git_commit_info>
    <metadata>
        <branch>${commitResult.branch}</branch>
        <commit_hash>${commitResult.commitHash}</commit_hash>
		<commit_message>${commitResult.commitMessage ?? "No message provided"}</commit_message>
        <timestamp>${new Date().toISOString()}</timestamp>
    </metadata>
    <description>
        <purpose>Version control reference for future operations</purpose>
        <usage>This commit hash can be used to revert changes or review modifications</usage>
    </description>
</git_commit_info>
`
	}

	public async handlePartialUpdateDiff(relPath: string, diff: string): Promise<void> {
		this.pQueue.add(() => this._handlePartialUpdateDiff(relPath, diff))
	}

	private async _handlePartialUpdateDiff(relPath: string, diff: string): Promise<void> {
		// Partial update always means "edit"
		const mode = "edit"

		if (!this.fileState) {
			// First update the UI / ask state to show 'loading'
			this.params.updateAsk(
				"tool",
				{
					tool: {
						tool: "file_editor",
						path: relPath,
						mode,
						kodu_diff: diff,
						approvalState: "loading",
						ts: this.ts,
					},
				},
				this.ts
			)

			// Check if file exists. If not, store an empty original.
			const absolutePath = path.resolve(getCwd(), relPath)
			const isExistingFile = await checkFileExists(relPath)
			if (!isExistingFile) {
				this.logger(`File does not exist: ${relPath}`, "error")
				this.fileState = {
					absolutePath,
					orignalContent: "",
					isExistingFile: false,
				}
				throw new Error(`File does not exist: ${relPath}`)
			}

			// Otherwise, read the file's original content
			const originalContent = fs.readFileSync(absolutePath, "utf8")
			this.fileState = {
				absolutePath,
				orignalContent: originalContent,
				isExistingFile: true,
			}
		}

		// 1) If we’re already finalizing the entire content, skip
		await this.params.updateAsk(
			"tool",
			{
				tool: {
					tool: "file_editor",
					path: relPath,
					mode,
					kodu_diff: diff,
					approvalState: "loading",
					ts: this.ts,
				},
			},
			this.ts
		)
		if (this.isProcessingFinalContent) {
			// this.logger("Skipping partial update because we're processing final content.", "warn")
			return
		}
		// 3) Use our new manager to parse/merge the blocks
		let newBlocks: EditBlock[] = []
		try {
			newBlocks = this.diffBlockManager.parseAndMergeDiff(diff, this.fileState.absolutePath)
		} catch (err) {
			this.logger(`Error parsing diff blocks: ${err}`, "error")
			return
		}

		// 4) If no blocks found, just return
		if (newBlocks.length === 0) {
			this.logger("No blocks found in partial diff chunk.", "debug")
			return
		}

		if (!this.inlineEditor.isOpen() && newBlocks.length > 0) {
			await this.inlineEditor.open(newBlocks[0]?.id, this.fileState.absolutePath, newBlocks[0].searchContent)
		}

		// Now we can see if the last block is finalized
		const lastBlock = newBlocks.at(-1)

		// get all the block that are finalized but not in the finalizedBlockIds
		const finalizedBlocks = newBlocks.filter(
			(block) => block.isFinalized && !this.finalizedBlockIds.includes(block.id)
		)
		// finalize them sequentially
		for (const block of finalizedBlocks) {
			await this.inlineEditor.applyFinalContent(block.id, block.searchContent, block.replaceContent)
			this.finalizedBlockIds.push(block.id)
		}

		if (!lastBlock) {
			return
		}
		if (lastBlock.isFinalized) {
			if (this.finalizedBlockIds.includes(lastBlock.id)) {
				return
			}
			// If that block is now fully finalized, we can apply final content, e.g.:
			this.logger(`Block is finalized, applying final content for block ID=${lastBlock.id}`, "debug")
			await this.inlineEditor.applyFinalContent(lastBlock.id, lastBlock.searchContent, lastBlock.replaceContent)
		} else {
			// Otherwise we do partial streaming
			await this.inlineEditor.applyStreamContent(lastBlock.id, lastBlock.searchContent, lastBlock.replaceContent)
		}
	}

	public async handlePartialUpdate(relPath: string, acculmatedContent: string): Promise<void> {
		const mode = "edit" // partial updates are edits
		if (!this.fileState) {
			const absolutePath = path.resolve(getCwd(), relPath)
			const isExistingFile = await checkFileExists(relPath)
			if (!isExistingFile) {
				this.logger(`File does not exist: ${relPath}`, "error")
				this.fileState = {
					absolutePath,
					orignalContent: "",
					isExistingFile: false,
				}
			} else {
				const originalContent = fs.readFileSync(absolutePath, "utf8")
				this.fileState = {
					absolutePath,
					orignalContent: originalContent,
					isExistingFile,
				}
			}
		}

		if (this.isProcessingFinalContent) {
			this.logger("Skipping partial update because the tool is processing the final content.", "warn")
			return
		}

		this.params.updateAsk(
			"tool",
			{
				tool: {
					tool: "file_editor",
					path: relPath,
					mode,
					kodu_content: acculmatedContent,
					approvalState: "loading",
					ts: this.ts,
				},
			},
			this.ts
		)

		this.pQueue.add(async () => {
			if (!this.diffViewProvider.isDiffViewOpen()) {
				try {
					const now = Date.now()
					await this.diffViewProvider.open(relPath)
					const elapsed = Date.now() - now
					this.logger(`Diff view opened in ${elapsed}ms`, "debug")
				} catch (e) {
					this.logger("Error opening diff view: " + e, "error")
					return
				}
			}
			await this.diffViewProvider.update(acculmatedContent, false)
		})
	}

	private async finalizeInlineEdit(path: string, content: string, allowFixed = true): Promise<ToolResponseV2> {
		const mode = "edit"
		this.isProcessingFinalContent = true

		// 1) Reset or parse new blocks from the final diff
		//    If you want to re-use the existing partial blocks,
		//    you might call .parseAndMergeDiff again or do something else
		this.diffBlockManager.parseAndMergeDiff(content, path)

		// 2) Grab the final blocks from the manager
		const editBlocks = this.diffBlockManager.blocks

		// 3) Force finalize them
		this.diffBlockManager.finalizeAllBlocks()

		// 4) Then apply them in the inline editor
		if (!this.inlineEditor.isOpen() && editBlocks.length > 0) {
			await this.inlineEditor.open(editBlocks[0]?.id, this.fileState!.absolutePath, editBlocks[0].searchContent)
		}

		const {
			failedCount,
			results: allResults,
			isAnyFailed,
			isAllFailed,
			failedBlocks,
		} = await this.inlineEditor.forceFinalize(editBlocks)

		this.logger(`Failed count: ${failedCount}, isAllFailed: ${isAllFailed}`, "debug")
		if (isAnyFailed) {
			// close the editor if all blocks failed
			this.inlineEditor.dispose()
			await this.inlineEditor.closeDiffEditors()
			//// disabled for now
			// if (allowFixed) {
			// 	// let's show a loading vs code toast
			// 	vscode.window.showInformationMessage("Attempting to fix the failed blocks")
			// 	const fixedOutput = await this.inlineFixRetry(allResults)
			// 	if (fixedOutput) {
			// 		await this.inlineEditor.rejectChanges()
			// 		await this.inlineEditor.dispose()

			// 		return await this.finalizeInlineEdit(path, fixedOutput, false)
			// 	} else {
			// 		// show vscode toast
			// 		vscode.window.showErrorMessage("Failed to fix the failed blocks")
			// 	}
			// }

			this.params.updateAsk(
				"tool",
				{
					tool: {
						tool: "file_editor",
						path,
						mode,
						kodu_diff: content,
						approvalState: "error",
						ts: this.ts,
						notAppliedCount: failedCount,
					},
				},
				this.ts
			)
			return this.toolResponse(
				"error",
				`<error_message>Failed to apply changes to the file. This is a fatal error than can be caused due to two reasons:
1. the search content was not found in the file, or the search content was not an exact letter by letter, space by space match with absolute accuracy.
2. the file content was modified or you don't have the latest file content in memory. Please retry the operation again with an absolute match of the search content.
If you encountured this error in editing to the same file path twice in a row, please refresh the file content by calling the read_file tool on the same file path to get the latest file content.
You must always use the latest file content as marked by the latest timestamp in the conversation history.
</error_message>
<not_applied_count>${failedCount}</not_applied_count>
<failed_to_match_blocks>
${failedBlocks?.map(
	(block) =>
		dedent`
<failed_block>
${SEARCH_HEAD}
${block.searchContent}
${SEPARATOR}
${block.replaceContent}
${REPLACE_HEAD}
</failed_block>
`
)}
</failed_to_match_blocks>`
			)
		}
		const { response, text, images } = await this.params.ask(
			"tool",
			{
				tool: {
					tool: "file_editor",
					path,
					mode,
					kodu_diff: content,
					approvalState: "pending",
					ts: this.ts,
				},
			},
			this.ts
		)
		if (response !== "yesButtonTapped") {
			this.params.updateAsk(
				"tool",
				{
					tool: {
						tool: "file_editor",
						path,
						mode,
						kodu_diff: content,
						approvalState: "rejected",
						ts: this.ts,
						userFeedback: text,
					},
				},
				this.ts
			)
			await this.inlineEditor.rejectChanges()
			if (response === "noButtonTapped") {
				return this.toolResponse("rejected", "Write operation cancelled by user.")
			}
			await this.params.say("user_feedback", text ?? "The user denied this operation.", images)
			return this.toolResponse(
				"feedback",
				`The user denied this operation:\n<user_feedback>${
					text ?? "No text feedback provided."
				}</user_feedback>`,
				images
			)
		}
		const { finalContent, results, finalContentRaw } = await this.inlineEditor.saveChanges()

		this.koduDev.getStateManager().addErrorPath(path)

		const notAppliedCount = results.filter((result) => !result.wasApplied).length
		const validationMsg =
			notAppliedCount === 0
				? `Your changes were applied, but always double-check correctness.`
				: `Failed to apply ${notAppliedCount} changes. Verify the search content and ensure correct context.`

		let commitXmlInfo = ""
		let commitResult: GitCommitResult | undefined
		try {
			commitResult = await this.koduDev.gitHandler.commitOnFileWrite(path, this.params.input.commit_message)
			commitXmlInfo = this.commitXMLGenerator(commitResult)
		} catch (error) {
			this.logger(`Error committing changes: ${error}`, "error")
		}
		const fileChangesetMessage = commitResult?.commitMessage
			? `<file_changeset_message>${commitResult.commitMessage}</file_changeset_message>`
			: ""
		// Save a new file version
		const newVersion = await this.saveNewFileVersion(path, finalContentRaw)
		this.params.updateAsk(
			"tool",
			{
				tool: {
					tool: "file_editor",
					path,
					mode,
					kodu_diff: content,
					approvalState: "approved",
					ts: this.ts,
					saved_version: newVersion.version.toString(),
					notAppliedCount,
					commitHash: commitResult?.commitHash,
					branch: commitResult?.branch,
				},
			},
			this.ts
		)

		const currentOutputMode = this.koduDev.getStateManager().inlineEditOutputType
		if (currentOutputMode === "diff") {
			return this.toolResponse(
				"success",
				dedent`<file_editor_response>
<status>
<result>success</result>
<operation>file_edit_with_diff</operation>
<timestamp>${new Date().toISOString()}</timestamp>
<validation>${validationMsg}</validation>
${commitXmlInfo}
</status>
<file_info>
<path>${path}</path>
<file_version>${newVersion.version}</file_version>
${fileChangesetMessage}
<file_version_timestamp>${new Date(newVersion.createdAt).toISOString()}</file_version_timestamp>
<information>The updated file content is shown below. This reflects the change that were applied and their current position in the file.
This should act as a source of truth for the changes that were made unless further modifications were made after this point.
</information>
<updated_file_content_blocks>
${results.map((res) => res.formattedSavedArea).join("\n-------\n")}
</updated_file_content_blocks>
</file_info>
</file_editor_response>`,
				undefined,
				commitResult
			)
		}

		return this.toolResponse(
			"success",
			`<file_editor_response>
<file_info>
<path>${path}</path>
<file_version>${newVersion.version}</file_version>
${fileChangesetMessage}
<file_content_timestamp>${new Date(newVersion.createdAt).toISOString()}</file_content_timestamp>
<message>Your changes were successfully applied to the file.
The latest updated file version is ${
				newVersion.version
			} you must remember this version of the file for future operations unless further modifications were made after this point.
If you want to rollback the changes you can call the file_editor tool with the rollback mode and the path of the file.
You must always find the latest file version and file_content_timestamp this will be your latest reference for '${path}' file.
</message>
<latest_file_content>
Here is the latest file content for version ${newVersion.version} at ${new Date(
				newVersion.createdAt
			).toISOString()} this is the only file content you should remember for future operations unless a newer version was created after this point in time and is referenced in the conversation history.
This is a critical reference point for the file content and must never be forgotten, you should never forget or reference any other version of the file content unless it was created after this point in time.
Always prioritize the last file version based on the timestamp and version number.
HERE IS THE FULL UPDATED FILE CONTENT FOR VERSION ${newVersion.version} AT ${new Date(
				newVersion.createdAt
			).toISOString()} FOR ${path}:
${finalContent}
</latest_file_content>
</file_info>
</file_editor_response>
		`,
			undefined,
			commitResult
		)
	}

	private async finalizeFileEdit(relPath: string, content: string): Promise<ToolResponseV2> {
		// determine mode based on whether content is entire or partial
		// If kodu_content is provided from input, it likely means whole content replacement. If kodu_diff, it's edit.
		// If we got here without diff, that means it's a "whole" operation.
		const mode = "whole_write"

		await this.showChangesInDiffView(relPath, content)
		this.logger(`Asking for approval to write to file: ${relPath}`, "info")

		this.params.updateAsk(
			"tool",
			{
				tool: {
					tool: "file_editor",
					path: relPath,
					mode,
					kodu_content: content,
					approvalState: "pending",
					ts: this.ts,
				},
			},
			this.ts
		)

		const { response, text, images } = await this.params.ask(
			"tool",
			{
				tool: {
					tool: "file_editor",
					path: relPath,
					mode,
					kodu_content: content,
					approvalState: "pending",
					ts: this.ts,
				},
			},
			this.ts
		)

		if (response !== "yesButtonTapped") {
			this.params.updateAsk(
				"tool",
				{
					tool: {
						tool: "file_editor",
						path: relPath,
						mode,
						kodu_content: content,
						approvalState: "rejected",
						ts: this.ts,
						userFeedback: text,
					},
				},
				this.ts
			)
			await this.diffViewProvider.revertChanges()

			if (response === "noButtonTapped") {
				return this.toolResponse("rejected", "Write operation cancelled by user.")
			}
			await this.params.say("user_feedback", text ?? "The user denied this operation.", images)
			return this.toolResponse("feedback", text ?? "The user denied this operation.", images)
		}

		this.logger(`User approved to write to file: ${relPath}`, "info")
		const { userEdits, finalContent } = await this.diffViewProvider.saveChanges()
		this.logger(`Changes saved to file: ${relPath}`, "info")
		this.koduDev.getStateManager().addErrorPath(relPath)

		let commitXmlInfo = ""
		let commitResult: GitCommitResult | undefined
		try {
			commitResult = await this.koduDev.gitHandler.commitOnFileWrite(relPath, this.params.input.commit_message)
			commitXmlInfo = this.commitXMLGenerator(commitResult)
		} catch (error) {
			this.logger(`Error committing changes: ${error}`, "error")
		}
		const newVersion = await this.saveNewFileVersion(relPath, finalContent)

		this.params.updateAsk(
			"tool",
			{
				tool: {
					tool: "file_editor",
					path: relPath,
					mode,
					kodu_content: content,
					saved_version: newVersion.version.toString(),
					approvalState: "approved",
					ts: this.ts,
					commitHash: commitResult?.commitHash,
					branch: commitResult?.branch,
				},
			},
			this.ts
		)

		let toolMsg = `The content was successfully saved to ${relPath.toPosix()}. you should remember this version of the file as the latest version of the file for future operations (unless further modifications were made after this point).
<file_version>${newVersion.version}</file_version>
<file_version_timestamp>${new Date(newVersion.createdAt).toISOString()}</file_version_timestamp>
${commitXmlInfo}
		`
		if (detectCodeOmission(this.diffViewProvider.originalContent || "", finalContent)) {
			this.logger(`Truncated content detected in ${relPath} at ${this.ts}`, "warn")
			toolMsg = `The content was successfully saved to ${relPath.toPosix()}. you should remember this version of the file as the latest version of the file for future operations (unless further modifications were made after this point).
but some code may have been omitted. Please ensure the full content is correct.
<file_version>${newVersion.version}</file_version>
<file_version_timestamp>${new Date(newVersion.createdAt).toISOString()}</file_version_timestamp>
${commitXmlInfo}`
		}

		if (userEdits) {
			await this.params.say(
				"user_feedback_diff",
				JSON.stringify({
					tool: this.fileState?.isExistingFile ? "editedExistingFile" : "newFileCreated",
					path: getReadablePath(getCwd(), relPath),
					diff: userEdits,
				} as ClaudeSayTool)
			)
			return this.toolResponse("success", toolMsg, undefined, commitResult)
		}

		return this.toolResponse("success", toolMsg, undefined, commitResult)
	}

	private async processFileWrite() {
		try {
			const { path: relPath, kodu_content: content, kodu_diff: diff, mode } = this.params.input
			if (!relPath) {
				throw new Error("Missing required parameter 'path'")
			}
			this.logger(`Writing to file: ${relPath}`, "info")

			this.isProcessingFinalContent = true
			await this.pQueue.clear()

			if (diff) {
				return await this.finalizeInlineEdit(relPath, diff)
			} else if (content) {
				return await this.finalizeFileEdit(relPath, content)
			} else {
				throw new Error("Missing required parameter 'kodu_content' or 'kodu_diff'")
			}
		} catch (error) {
			this.logger(`Error in processFileWrite: ${error}`, "error")
			const mode = this.params.input.mode
			this.params.updateAsk(
				"tool",
				{
					tool: {
						tool: "file_editor",
						path: this.params.input.path ?? "",
						mode,
						kodu_content: this.params.input.kodu_content ?? undefined,
						kodu_diff: this.params.input.kodu_diff ?? undefined,
						approvalState: "error",
						ts: this.ts,
						error: `Failed to write to file`,
					},
				},
				this.ts
			)

			return this.toolResponse(
				"error",
				`Write to File Error: ${error instanceof Error ? error.message : String(error)}`
			)
		} finally {
			this.isProcessingFinalContent = false
		}
	}

	public override async abortToolExecution(): Promise<{ didAbort: boolean }> {
		const { didAbort } = await super.abortToolExecution()

		if (didAbort) {
			this.pQueue.clear()
			if (this.params.input.kodu_diff) {
				await this.inlineEditor.rejectChanges()
				await this.inlineEditor.dispose()
			} else {
				await this.diffViewProvider.revertChanges()
				this.diffViewProvider.reset()
			}
		}

		return { didAbort }
	}

	private async showChangesInDiffView(relPath: string, content: string): Promise<void> {
		content = preprocessContent(content)
		if (!this.diffViewProvider.isDiffViewOpen()) {
			await this.diffViewProvider.open(relPath)
		}

		this.pQueue.add(async () => {
			await this.diffViewProvider.update(content, true)
		})
		await this.pQueue.onIdle()
	}

	/**
	 * Saves a new file version after changes are made to the file.
	 */
	private async saveNewFileVersion(relPath: string, content: string): Promise<FileVersion> {
		const versions = await this.koduDev.getStateManager().getFileVersions(relPath)
		// if we don't have any versions we only need to save the original content as the first version of the file
		if (versions.length === 0) {
			const newVersion: FileVersion = {
				path: relPath,
				version: 0,
				createdAt: Date.now(),
				content: this.fileState?.orignalContent ?? "",
			}
			await this.koduDev.getStateManager().saveFileVersion(newVersion)
			return newVersion
		}
		const nextVersion = versions.length > 0 ? Math.max(...versions.map((v) => v.version)) + 1 : 1
		const newVersion: FileVersion = {
			path: relPath,
			version: nextVersion,
			createdAt: Date.now(),
			content,
		}
		await this.koduDev.getStateManager().saveFileVersion(newVersion)
		return newVersion
	}

	private async handleRollback(relPath: string): Promise<ToolResponseV2> {
		const mode = "rollback"

		const versions = await this.koduDev.getStateManager().getFileVersions(relPath)
		const versionToRollback = versions.at(-1)
		if (!versionToRollback) {
			return this.toolResponse(
				"error",
				`<rollback_response><status>error</status><message>No versions found.</message></rollback_response>`
			)
		}

		// Show using the native diff view:
		const absolutePath = path.resolve(getCwd(), relPath)
		const isExistingFile = await checkFileExists(relPath)
		let originalContent = ""
		if (isExistingFile) {
			originalContent = fs.readFileSync(absolutePath, "utf8")
		}

		await this.diffViewProvider.open(relPath)
		await this.diffViewProvider.update(versionToRollback.content, true)

		// Ask for approval (pending)
		this.params.updateAsk(
			"tool",
			{
				tool: {
					tool: "file_editor",
					path: relPath,
					mode,
					kodu_content: versionToRollback.content,
					approvalState: "pending",
					ts: this.ts,
				},
			},
			this.ts
		)

		const { response, text, images } = await this.params.ask(
			"tool",
			{
				tool: {
					tool: "file_editor",
					path: relPath,
					mode,
					kodu_content: versionToRollback.content,
					approvalState: "pending",
					ts: this.ts,
				},
			},
			this.ts
		)

		if (response !== "yesButtonTapped") {
			this.params.updateAsk(
				"tool",
				{
					tool: {
						tool: "file_editor",
						path: relPath,
						mode,
						kodu_content: versionToRollback.content,
						approvalState: "rejected",
						userFeedback: text,
						ts: this.ts,
					},
				},
				this.ts
			)
			await this.diffViewProvider.revertChanges()
			if (response === "messageResponse") {
				await this.params.say("user_feedback", text ?? "The user denied this operation.", images)

				return this.toolResponse("feedback", text ?? "The user denied this operation.", images)
			}
			return this.toolResponse("rejected", "Rollback operation cancelled by user.")
		}

		// Approved
		const file = await this.diffViewProvider.saveChanges()
		if (versionToRollback.content === "") {
			// delete the file
			await unlink(absolutePath)
		} else {
			// we want to add it to error paths if it's not empty and delete
			this.koduDev.getStateManager().addErrorPath(relPath)
		}
		let commitXmlInfo = ""
		let commitResult: GitCommitResult | undefined
		try {
			commitResult = await this.koduDev.gitHandler.commitOnFileWrite(relPath, this.params.input.commit_message)
			commitXmlInfo = this.commitXMLGenerator(commitResult)
		} catch {}

		await this.koduDev.getStateManager().deleteFileVersion(versionToRollback)

		this.params.updateAsk(
			"tool",
			{
				tool: {
					tool: "file_editor",
					path: relPath,
					mode,
					kodu_content: versionToRollback.content,
					approvalState: "approved",
					ts: this.ts,
					commitHash: commitResult?.commitHash,
					branch: commitResult?.branch,
				},
			},
			this.ts
		)

		return this.toolResponse(
			"success",
			`<rollback_response><status>success</status><operation>rollback</operation><current_available_versions>${
				versions.length - 1 > 0 ? versions.length - 1 : 0
			}</current_available_versions><file_version_timestamp>${new Date(
				versionToRollback.createdAt
			).toISOString()}</file_version_timestamp>${commitXmlInfo}<critical_information>From now on, the file will be reverted to the version that was rolled back to.I'm providing you the latest file content below for reference, you should only remember this file version unless further modifications were made after this point.From now on file '${relPath}' content will be the content shown in <updated_file_content> field. </critical_information><updated_file_content>Here is the latest file content after the rollback you should remember this content as the latest file content unless you make further modifications.${formatFileToLines(
				file.finalContent
			)}</updated_file_content></rollback_response>`
		)
	}
}
