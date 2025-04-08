import * as fs from "fs/promises"
import { globby, Options } from "globby"
import os from "os"
import * as path from "path"
import { LanguageParser, loadRequiredLanguageParsers } from "./language-parser"
import { arePathsEqual, fileExistsAtPath } from "../utils/path-helpers"

export const LIST_FILES_LIMIT = 200

export async function parseSourceCodeForDefinitionsTopLevel(dirPath: string): Promise<string> {
	const absoluteDir = path.resolve(dirPath)

	const dirExists = await fileExistsAtPath(absoluteDir)
	if (!dirExists) {
		return `<repo_map>This directory does not exist or is not accessible: ${dirPath}</repo_map>`
	}

	// Get top-level files (non-recursive)
	const [allFiles, _] = await listFiles(dirPath, false, LIST_FILES_LIMIT)
	const { filesToParse, remainingFiles } = separateFiles(allFiles)

	const languageParsers = await loadRequiredLanguageParsers(filesToParse)
	const filesWithoutDefinitions: string[] = []

	let result = ""

	// Parse files that have language support
	for (const file of filesToParse) {
		const definitions = await parseFile(file, languageParsers, dirPath)
		if (definitions) {
			result += definitions
		} else {
			filesWithoutDefinitions.push(file)
		}
	}

	// Unparsed files section
	const unparsed = filesWithoutDefinitions.concat(remainingFiles).sort()
	if (unparsed.length > 0) {
		result += "UNPARSED FILES\n"
		for (const file of unparsed) {
			result += `${path.relative(dirPath, file)}\n`
		}
	}

	if (!result.trim()) {
		result = "No source code definitions found."
	}

	return `<repo_map>${result.trim()}</repo_map>`
}

export async function listFiles(dirPath: string, recursive: boolean, limit: number): Promise<[string[], boolean]> {
	const absolutePath = path.resolve(dirPath)
	const root = process.platform === "win32" ? path.parse(absolutePath).root : "/"
	const isRoot = arePathsEqual(absolutePath, root)
	if (isRoot) {
		return [[root], false]
	}
	const homeDir = os.homedir()
	const isHomeDir = arePathsEqual(absolutePath, homeDir)
	if (isHomeDir) {
		return [[homeDir], false]
	}

	const dirsToIgnore = [
		"node_modules",
		"__pycache__",
		"env",
		"venv",
		"target/dependency",
		"build/dependencies",
		"dist",
		"out",
		"bundle",
		"vendor",
		"tmp",
		"temp",
		"deps",
		"pkg",
		"Pods",
		".*",
	].map((dir) => `**/${dir}/**`)

	const options: Options = {
		cwd: dirPath,
		dot: true,
		absolute: true,
		markDirectories: true,
		gitignore: recursive,
		ignore: recursive ? dirsToIgnore : undefined,
		onlyFiles: false,
	}

	const files = recursive ? await globbyLevelByLevel(limit, options) : (await globby("*", options)).slice(0, limit)
	return [files, files.length >= limit]
}

async function globbyLevelByLevel(limit: number, options?: Options) {
	let results: Set<string> = new Set()
	let queue: string[] = ["*"]

	const globbingProcess = async () => {
		while (queue.length > 0 && results.size < limit) {
			const pattern = queue.shift()!
			const filesAtLevel = await globby(pattern, options)

			for (const file of filesAtLevel) {
				if (results.size >= limit) {
					break
				}
				results.add(file)
				if (file.endsWith("/")) {
					queue.push(`${file}*`)
				}
			}
		}
		return Array.from(results).slice(0, limit)
	}

	const timeoutPromise = new Promise<string[]>((_, reject) => {
		setTimeout(() => reject(new Error("Globbing timeout")), 10000)
	})

	try {
		return await Promise.race([globbingProcess(), timeoutPromise])
	} catch (error) {
		console.warn("Globbing timed out, returning partial results")
		return Array.from(results)
	}
}

function separateFiles(allFiles: string[]): { filesToParse: string[]; remainingFiles: string[] } {
	const extensions = [
		"js",
		"jsx",
		"ts",
		"tsx",
		"py",
		"rs",
		"go",
		"c",
		"h",
		"cpp",
		"hpp",
		"cs",
		"rb",
		"java",
		"php",
		"swift",
	].map((e) => `.${e}`)
	const filesToParse = allFiles.filter((file) => extensions.includes(path.extname(file))).slice(0, 50)
	const remainingFiles = allFiles.filter((file) => !filesToParse.includes(file))
	return { filesToParse, remainingFiles }
}

async function parseFile(
	filePath: string,
	languageParsers: LanguageParser,
	baseDir: string
): Promise<string | undefined> {
	const fileContent = await fs.readFile(filePath, "utf8")
	const ext = path.extname(filePath).toLowerCase().slice(1)

	const { parser, query } = languageParsers[ext] || {}
	if (!parser || !query) {
		return `|----\nUnsupported file type: ${filePath}\n|----`
	}

	// Use sets to avoid duplicates
	const imports = new Set<string>()
	const classes = new Set<string>()
	const functions = new Set<string>()
	const functionCalls = new Set<string>()
	const methodCalls = new Set<string>()

	try {
		const tree = parser.parse(fileContent)
		const captures = query.captures(tree.rootNode)
		for (const capture of captures) {
			const { node, name } = capture
			const text = fileContent.substring(node.startIndex, node.endIndex)

			if (name === "name.import.module") {
				imports.add(text)
			} else if (name === "name.definition.class") {
				classes.add(text)
			} else if (name === "name.definition.function") {
				functions.add(text)
			} else if (name === "name.call") {
				functionCalls.add(text)
			} else if (name === "name.method_call") {
				methodCalls.add(text)
			}
		}
	} catch (error) {
		console.log(`Error parsing file: ${error}\n`)
	}

	// If no results, return undefined
	if (
		imports.size === 0 &&
		classes.size === 0 &&
		functions.size === 0 &&
		functionCalls.size === 0 &&
		methodCalls.size === 0
	) {
		return undefined
	}

	const relativePath = path.relative(baseDir, filePath)
	let output = `${relativePath}\n`

	// Print categories in a clean way, only if they have content.
	const appendCategory = (title: string, items: Set<string>, prefix: string) => {
		if (items.size > 0) {
			output += "|----\n"
			for (const item of items) {
				output += `${prefix}${item}\n`
			}
		}
	}

	appendCategory("Imports", imports, "│Import Module: ")
	appendCategory("Classes", classes, "│Class: ")
	appendCategory("Functions", functions, "│Function: ")
	appendCategory("Function Calls", functionCalls, "│Function Call: ")
	appendCategory("Method Calls", methodCalls, "│Method Call: ")

	return output
}
