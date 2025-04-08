import { InterestedFile } from "../agent/v1/main-agent"

export type HistoryItem = {
	id: string
	ts: number
	task: string
	tokensIn: number
	tokensOut: number
	cacheWrites?: number
	cacheReads?: number
	totalCost: number
	name?: string
	dirAbsolutePath?: string
	isRepoInitialized?: boolean
	currentTokens?: number
	currentSubAgentId?: number
	isCompleted?: boolean
	manuallyMarkedCompletedAt?: number
}

export const isSatifiesHistoryItem = (item: any): item is HistoryItem => {
	return (
		typeof item.id === "string" &&
		typeof item.ts === "number" &&
		typeof item.task === "string" &&
		typeof item.tokensIn === "number" &&
		typeof item.tokensOut === "number" &&
		typeof item.totalCost === "number"
	)
}
