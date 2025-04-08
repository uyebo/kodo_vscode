import { atom } from "jotai"
import { toolPrompts } from "extension/agent/v1/prompts/tools"
import { ToolPromptSchema } from "extension/agent/v1/prompts/utils/utils"
import { ToolName } from "extension/agent/v1/tools/types"

export const tools = toolPrompts.reduce((acc, tool) => {
	acc[tool.name] = tool
	return acc
}, {} as Record<ToolName, ToolPromptSchema>)

export const disabledToolsAtom = atom(new Set<ToolName>())

export const currentPromptContentAtom = atom("")

export const isCurrentPreviewAtom = atom(false)
