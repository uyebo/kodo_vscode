import delay from "delay"
import { serializeError } from "serialize-error"
import { AdvancedTerminalManager } from "../../../../integrations/terminal"
import { getCwd } from "../../utils"
import { BaseAgentTool } from "../base-agent.tool"
import { TerminalProcessResultPromise } from "../../../../integrations/terminal/terminal-manager"
import { GlobalStateManager } from "../../../../providers/state/global-state-manager"
import { ToolResponseV2 } from "../../types"
import { GitCommitResult } from "../../handlers"
import { ExecuteCommandToolParams } from "../schema/execute_command"

const COMMAND_TIMEOUT = 90 // 90 seconds
const MAX_RETRIES = 3

type EarlyExitState = "approved" | "rejected" | "pending"

export const shellIntegrationErrorOutput = `
<command_execution_response>
	<status>
		<result>error</result>
		<operation>command_execution</operation>
		<timestamp>${new Date().toISOString()}</timestamp>
		<error_type>shell_integration_unavailable</error_type>
	</status>
	<error_details>
		<message>Shell integration is not available. The command was executed but output cannot be captured.</message>
		<required_action>User must enable shell integration to capture command output</required_action>
		<limitations>
			<current>Can only run commands without capturing output</current>
			<resolution>Enable shell integration to capture command output</resolution>
		</limitations>
	</error_details>
</command_execution_response>
`

export class ExecuteCommandTool extends BaseAgentTool<ExecuteCommandToolParams> {
	private output: string = ""

	async execute() {
		const { input, say } = this.params
		const command = input.command

		if (!command?.trim()) {
			await say(
				"error",
				"Kodu tried to use execute_command without value for required parameter 'command'. Retrying..."
			)
			return this.toolResponse(
				"error",
				`Error: Missing or empty command parameter. Please provide a valid command.`
			)
		}

		return this.executeShellTerminal(command)
	}

	private isApprovedState(state: EarlyExitState): state is "approved" {
		return state === "approved"
	}

	private async executeShellTerminal(command: string): Promise<ToolResponseV2> {
		const { terminalManager } = this.koduDev
		if (!(terminalManager instanceof AdvancedTerminalManager)) {
			throw new Error("AdvancedTerminalManager is not available")
		}

		const { ask, updateAsk, say, returnEmptyStringOnSuccess } = this.params
		const cwd = getCwd()

		// Initial approval request
		const { response, text, images } = await ask(
			"tool",
			{
				tool: {
					tool: "execute_command",
					command,
					approvalState: "pending",
					ts: this.ts,
					isSubMsg: this.params.isSubMsg,
				},
			},
			this.ts
		)

		if (response !== "yesButtonTapped") {
			await this.params.updateAsk(
				"tool",
				{
					tool: {
						tool: "execute_command",
						command,
						approvalState: "rejected",
						ts: this.ts,
						isSubMsg: this.params.isSubMsg,
					},
				},
				this.ts
			)

			if (response === "messageResponse") {
				await this.params.updateAsk(
					"tool",
					{
						tool: {
							tool: "execute_command",
							command,
							approvalState: "rejected",
							ts: this.ts,
							userFeedback: text,
							isSubMsg: this.params.isSubMsg,
						},
					},
					this.ts
				)
				await this.params.say("user_feedback", text ?? "The user denied this operation.", images)
				return this.toolResponse("feedback", this.formatToolDeniedFeedback(text), images)
			}
			return this.toolResponse("rejected", this.formatToolDenied())
		}

		// Set loading state
		await this.params.updateAsk(
			"tool",
			{
				tool: {
					tool: "execute_command",
					command,
					approvalState: "loading",
					ts: this.ts,
					isSubMsg: this.params.isSubMsg,
				},
			},
			this.ts
		)

		let process: TerminalProcessResultPromise | null = null

		const terminalInfo = await terminalManager.getOrCreateTerminal(this.cwd)
		terminalInfo.terminal.show()

		let preCommandCommit = ""
		// try {
		// 	const commitResult = await this.koduDev.gitHandler.commitEverything(
		// 		`State before executing command \`${command}\``
		// 	)
		// 	preCommandCommit = commitResult.commitHash
		// } catch (error) {
		// 	console.error("Failed to get pre-command commit:", error)
		// }

		process = terminalManager.runCommand(terminalInfo, command, {
			autoClose: this.koduDev.getStateManager().autoCloseTerminal ?? false,
		})

		if (!process) {
			throw new Error("Failed to create terminal process after retries")
		}

		let userFeedback: { text?: string; images?: string[] } | undefined
		let didContinue = false
		let earlyExit: EarlyExitState = "pending"

		let completed = false
		let shellIntegrationWarningShown = false

		try {
			const completionPromise = new Promise<void>((resolve) => {
				process!.once("completed", () => {
					earlyExit = "approved"
					completed = true
					setTimeout(resolve, 0, undefined)
				})
				process.once("no_shell_integration", async () => {
					await say("shell_integration_warning", shellIntegrationErrorOutput)
					await this.params.updateAsk(
						"tool",
						{
							tool: {
								tool: "execute_command",
								command,
								output: this.output,
								approvalState: "error",
								ts: this.ts,
								error: "Shell integration is not available, cannot read output.",
								earlyExit: undefined,
								isSubMsg: this.params.isSubMsg,
							},
						},
						this.ts
					)
					shellIntegrationWarningShown = true
					completed = true
					earlyExit = "approved"
					resolve()
				})
			})
			process.on("line", async (line) => {
				const cleanedLine = line
				if (cleanedLine) {
					this.output += cleanedLine + "\n"
					if (!didContinue || this.isApprovedState(earlyExit)) {
						try {
							await this.params.updateAsk(
								"tool",
								{
									tool: {
										tool: "execute_command",
										command,
										output: this.output,
										approvalState: "loading",
										ts: this.ts,
										earlyExit,
										isSubMsg: this.params.isSubMsg,
									},
								},
								this.ts
							)
						} catch (error) {
							console.error("Failed to update output:", error)
						}
					}
				}
			})
			process.on("error", async (error) => {
				console.log(`Error in process: ${error}`)
			})

			const timeout = GlobalStateManager.getInstance().getGlobalState("commandTimeout")
			const commandTimeout = (timeout ?? COMMAND_TIMEOUT) * 1000
			// Wait for either completion or timeout
			await Promise.race([
				completionPromise,
				delay(commandTimeout).then(() => {
					if (!completed) {
						console.log("Command timed out after", commandTimeout, "ms")
					}
				}),
			])

			// Ensure all output is processed
			await delay(300)
			if (shellIntegrationWarningShown) {
				return this.toolResponse("error", shellIntegrationErrorOutput)
			}

			await this.params.updateAsk(
				"tool",
				{
					tool: {
						tool: "execute_command",
						command,
						output: this.output,
						approvalState: "approved",
						ts: this.ts,
						earlyExit,
						isSubMsg: this.params.isSubMsg,
					},
				},
				this.ts
			)

			if ((userFeedback?.text && userFeedback.text.length) || userFeedback?.images?.length) {
				await this.params.updateAsk(
					"tool",
					{
						tool: {
							tool: "execute_command",
							command,
							output: this.output,
							approvalState: "approved",
							ts: this.ts,
							earlyExit,
							userFeedback: userFeedback.text,
							isSubMsg: this.params.isSubMsg,
						},
					},
					this.ts
				)

				// try {
				// 	commitResult = await this.koduDev.gitHandler.commitEverything(
				// 		`State after executing command \`${command}\``
				// 	)
				// } catch (error) {
				// 	console.error("Failed to get post-command commit:", error)
				// }

				const toolRes = `
					<command_execution_response>
						<status>
							<result>success</result>
							<operation>command_execution</operation>
							<timestamp>${new Date().toISOString()}</timestamp>
						</status>
						<execution_details>
							<command_info>
								<executed_command>${command}</executed_command>
								<working_directory>${this.cwd}</working_directory>
							</command_info>
							<output>
								<content>${this.output}</content>
							</output>
							<user_feedback>
								<message>${userFeedback?.text || ""}</message>
							</user_feedback>
						</execution_details>
					</command_execution_response>`

				if (returnEmptyStringOnSuccess) {
					return this.toolResponse("success", "No output", undefined)
				}

				return this.toolResponse("success", toolRes, userFeedback?.images)
			} else {
				const toolRes = `
			<command_execution_response>
				<status>
					<result>${completed ? "executed sucessfully" : "execution in progress"}</result>
					<operation>command_execution</operation>
					<timestamp>${new Date().toISOString()}</timestamp>
				</status>
				<execution_details>
					<command_info>
						<executed_command>${command}</executed_command>
						<working_directory>${this.cwd}</working_directory>
					</command_info>
					<output>
						<content>${this.output || "No output"}</content>
						${
							shellIntegrationErrorOutput
								? `<shell_integration_error>${shellIntegrationErrorOutput}</shell_integration_error>`
								: ""
						}
						${earlyExit === "pending" ? `<early_exit>pending</early_exit>` : `<early_exit>${earlyExit}</early_exit>`}
						<note>${
							completed
								? "Command executed successfully"
								: "Command execution in progress partial output may be available you can continue with task if you think it's good to go"
						}</note>
						}
					</output>
				</execution_details>
			</command_execution_response>`

				return this.toolResponse("success", toolRes, userFeedback?.images)
			}
		} catch (error) {
			const errorMessage = (error as Error)?.message || JSON.stringify(serializeError(error), null, 2)
			await updateAsk(
				"tool",
				{
					tool: {
						tool: "execute_command",
						command,
						output: errorMessage,
						approvalState: "error",
						ts: this.ts,
						earlyExit: undefined,
						isSubMsg: this.params.isSubMsg,
					},
				},
				this.ts
			)
			return this.toolResponse("error", this.formatToolError(`Error executing command:\n${errorMessage}`))
		}
	}
}
