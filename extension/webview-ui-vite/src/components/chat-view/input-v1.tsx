import { vscode } from "@/utils/vscode"
import { useAtom } from "jotai"
import React, { KeyboardEvent, forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react"
import { useEvent } from "react-use"
import { ExtensionMessage } from "extension/shared/messages/extension-message"
import { Resource } from "extension/shared/messages/client-message"
import AttachedResources from "./attached-resources"
import FileDialog from "./file-dialog"
import InputTextArea from "./input-text-area"
import MentionPopover, { popoverOptions } from "./mention-popover"
import ScrapeDialog from "./scrape-dialog"
import { FileNode } from "./file-tree"
import { attachmentsAtom } from "./atoms"

type InputOpts = {
	value: string
	disabled: boolean
	isRequestRunning: boolean
	onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
	onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
	onFocus: () => void
	onBlur: () => void
	onPaste: (e: React.ClipboardEvent) => void
	thumbnailsHeight: number
	onInsertAt?: () => void
}

const InputV2 = forwardRef<HTMLTextAreaElement, InputOpts>((props, forwardedRef) => {
	const handleInsertAt = () => {
		if (props.onInsertAt) {
			props.onInsertAt()
		} else {
			const newText = props.value + "@"
			props.onChange({
				target: { value: newText },
				persist: () => {},
			} as React.ChangeEvent<HTMLTextAreaElement>)
			setTimeout(() => {
				if (localTextareaRef.current) {
					localTextareaRef.current.focus()
					localTextareaRef.current.setSelectionRange(newText.length, newText.length)
				}
			}, 0)
		}
	}
	const [showPopover, setShowPopover] = useState(false)
	const [textareaValue, setTextareaValue] = useState(props.value ?? "")
	const [cursorPosition, setCursorPosition] = useState(0)
	const [focusedIndex, setFocusedIndex] = useState(-1)
	const localTextareaRef = useRef<HTMLTextAreaElement>(null)
	const [openDialog, setOpenDialog] = useState<string | null>(null)
	const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set())
	const [scrapeUrl, setScrapeUrl] = useState("")
	const [scrapeDescription, setScrapeDescription] = useState("")
	const [fileTree, setFileTree] = useState<FileNode[]>([])
	const [attachedResources, setAttachedResources] = useAtom(attachmentsAtom)
	useImperativeHandle(forwardedRef, () => localTextareaRef.current!, [])

	useEffect(() => {
		vscode.postMessage({ type: "fileTree" })
	}, [])

	const handleMessage = useCallback((e: MessageEvent) => {
		const message: ExtensionMessage = e.data
		if (message.type === "fileTree") {
			setFileTree(message.tree)
		}
	}, [])

	useEvent("message", handleMessage)

	const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		props.onChange(e)
		const newValue = e.target.value
		const previousValue = textareaValue
		setTextareaValue(newValue)

		// check if this was a paste event skipping the "@" check
		if (newValue.length > previousValue.length + 1) {
			return
		}

		const newAtPositions = getAllAtPositions(newValue)
		const prevAtPositions = getAllAtPositions(previousValue)

		if (newAtPositions.length > prevAtPositions.length) {
			// A new "@" was added
			const newAtPosition = newAtPositions.find((pos) => !prevAtPositions.includes(pos))
			if (newAtPosition !== undefined) {
				setShowPopover(true)
				setFocusedIndex(0)
				setCursorPosition(newAtPosition + 1)
			}
		} else if (newAtPositions.length < prevAtPositions.length) {
			// An "@" was removed
			if (newAtPositions.length === 0) {
				setShowPopover(false)
			} else {
				// Optional: focus on the last remaining "@"
				setCursorPosition(newAtPositions[newAtPositions.length - 1] + 1)
			}
		}
	}

	// Helper function to get all "@" positions
	const getAllAtPositions = (text: string): number[] => {
		const positions: number[] = []
		let position = text.indexOf("@")
		while (position !== -1) {
			positions.push(position)
			position = text.indexOf("@", position + 1)
		}
		return positions
	}

	const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (!showPopover) {
			props.onKeyDown(e)
		}
		if (showPopover) {
			switch (e.key) {
				case "ArrowDown":
				case "Tab":
					e.preventDefault()
					setFocusedIndex((prevIndex) => (prevIndex + 1) % popoverOptions.length)
					break
				case "ArrowUp":
					e.preventDefault()
					setFocusedIndex((prevIndex) => (prevIndex - 1 + popoverOptions.length) % popoverOptions.length)
					break
				case "Enter":
					if (focusedIndex !== -1) {
						e.preventDefault()
						handleOpenDialog(popoverOptions[focusedIndex].name)
					}
					break
				case "Escape":
					e.preventDefault()
					setShowPopover(false)
					break
			}
		}
	}

	const handleSubmitSelection = () => {
		const newResources: Resource[] = Array.from(selectedItems).map((item) => ({
			id: item,
			type: item.includes(".") ? "file" : "folder",
			name: item.split("/").pop() || item,
		}))
		setAttachedResources((prev) => [...prev, ...newResources])
		handleCloseDialog()
	}

	const handleScrapeSubmit = () => {
		if (scrapeUrl) {
			const newResource: Resource = {
				id: Date.now().toString(),
				type: "url",
				description: scrapeDescription,
				name: scrapeUrl,
			}
			console.debug(newResource)
			setAttachedResources((prev) => [...prev, newResource])
			handleCloseDialog()
		}
	}

	const handleOpenDialog = (dialogName: string) => {
		setShowPopover(false)
		if (dialogName === "debug") {
			vscode.postMessage({ type: "debug" })
			handleCloseDialog()
			return
		}
		setOpenDialog(dialogName)
		if (openDialog === "fileFolder") {
			vscode.postMessage({ type: "fileTree" })
		}
	}

	const handleCloseDialog = () => {
		// remove @ from the text
		const newText = textareaValue.slice(0, cursorPosition - 1) + textareaValue.slice(cursorPosition)
		setTextareaValue(newText)
		props.onChange({ target: { value: newText } } as React.ChangeEvent<HTMLTextAreaElement>)
		setShowPopover(false)
		setOpenDialog(null)
		setSelectedItems(new Set())
		setScrapeUrl("")
		setScrapeDescription("")
		localTextareaRef.current?.focus()
	}

	const handleRemoveResource = (id: string) => {
		setAttachedResources((prev) => prev.filter((resource) => resource.id !== id))
	}

	return (
		<>
			<div className="relative w-full">
				<MentionPopover
					showPopover={showPopover}
					setShowPopover={setShowPopover}
					focusedIndex={focusedIndex}
					setFocusedIndex={setFocusedIndex}
					handleOpenDialog={handleOpenDialog}
					// @ts-expect-error - event types are not the same but it's ok
					handleKeyDown={handleKeyDown}
				/>
				<AttachedResources
					onRemoveAll={() => setAttachedResources([])}
					resources={attachedResources}
					onRemove={handleRemoveResource}
				/>
				<InputTextArea
					{...props}
					ref={localTextareaRef}
					value={props.value}
					onChange={handleTextareaChange}
					onKeyDown={handleKeyDown}
					setShowPopover={setShowPopover}
				/>
			</div>

			<FileDialog
				open={openDialog === "fileFolder"}
				onClose={handleCloseDialog}
				fileTree={fileTree}
				selectedItems={selectedItems}
				setSelectedItems={setSelectedItems}
				onSubmit={handleSubmitSelection}
			/>

			<ScrapeDialog
				open={openDialog === "scrape"}
				onClose={handleCloseDialog}
				scrapeUrl={scrapeUrl}
				setScrapeUrl={setScrapeUrl}
				scrapeDescription={scrapeDescription}
				setScrapeDescription={setScrapeDescription}
				onSubmit={handleScrapeSubmit}
			/>
		</>
	)
})

InputV2.displayName = "InputV2"

export default InputV2
