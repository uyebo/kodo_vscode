import { ToolPromptSchema } from "../utils/utils"

export const listFilesPrompt: ToolPromptSchema = {
	name: "list_files",
	description:
		"Request to list files and directories within the specified directory. If recursive is true, it will list all files and directories recursively. If recursive is false or not provided, it will only list the top-level contents. Do not use this tool to confirm the existence of files you may have created, as the user will let you know if the files were created successfully or not.",
	parameters: {
		path: {
			type: "string",
			description: `The path of the directory to list contents for (relative to the current working directory {{cwd}})`,
			required: true,
		},
		recursive: {
			type: "string",
			description:
				"Whether to list files recursively. Use true for recursive listing, false or omit for top-level only.",
			required: false,
		},
	},
	capabilities: [
		"You can use list_files tool to list files and directories within the specified directory. This tool is useful for understanding the contents of a directory, verifying the presence of files, or identifying the structure of a project.",
	],

	examples: [
		{
			description: "List files",
			output: `<list_files>
<path>Directory path here</path>
<recursive>true or false (optional)</recursive>
</list_files>`,
		},
	],
}
