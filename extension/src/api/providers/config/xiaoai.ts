
// providers/openai.ts
import { ProviderConfig } from "../types"
import { DEFAULT_BASE_URLS, PROVIDER_IDS, PROVIDER_NAMES } from "../constants"

export const openaiConfig: ProviderConfig = {
	id: PROVIDER_IDS.XIAOAI,
	name: PROVIDER_NAMES[PROVIDER_IDS.XIAOAI],
	baseUrl: DEFAULT_BASE_URLS[PROVIDER_IDS.XIAOAI],
	models: [
		{
			id: "xiaoai",
			name: "xiaoai",
			contextWindow: 200_000,
			maxTokens: 128000,
			supportsImages: false,
			supportsPromptCache: true,
			inputPrice: 1.1,
			outputPrice: 4.4,
			cacheReadsPrice: 1.1 * 0.5, // 50% of input price
			cacheWritesPrice: 1.1,
			provider: PROVIDER_IDS.XIAOAI,
			isThinkingModel: true,
			reasoningEffort: "high",
		},
		
	],
	requiredFields: ["apiKey"],
}
