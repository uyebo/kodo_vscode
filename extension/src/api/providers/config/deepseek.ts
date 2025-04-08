// providers/deepseek.ts
import { ProviderConfig } from "../types"
import { DEFAULT_BASE_URLS, PROVIDER_IDS, PROVIDER_NAMES } from "../constants"

export const deepseekConfig: ProviderConfig = {
	id: PROVIDER_IDS.DEEPSEEK,
	name: PROVIDER_NAMES[PROVIDER_IDS.DEEPSEEK],
	baseUrl: DEFAULT_BASE_URLS[PROVIDER_IDS.DEEPSEEK],
	models: [
		{
			id: "deepseek-chat",
			name: "DeepSeek Chat",
			contextWindow: 64000,
			maxTokens: 8192,
			supportsImages: false,
			inputPrice: 0.14, // $0.14 per 1M tokens (cache miss)
			outputPrice: 0.28, // $0.28 per 1M tokens
			cacheReadsPrice: 0.014, // $0.014 per 1M tokens (cache hit)
			cacheWritesPrice: 0.14, // $0.14 per 1M tokens (same as input price)
			supportsPromptCache: true,
			isRecommended: true,
			provider: PROVIDER_IDS.DEEPSEEK,
		},
		{
			id: "deepseek-reasoner",
			name: "DeepSeek R1",
			contextWindow: 64000,
			maxTokens: 8192,
			supportsImages: false,
			inputPrice: 0.55,
			outputPrice: 2.19,
			cacheReadsPrice: 0.14,
			cacheWritesPrice: 0.55,
			supportsPromptCache: true,
			isThinkingModel: true,
			isRecommended: true,
			provider: PROVIDER_IDS.DEEPSEEK,
		},
	],
	requiredFields: ["apiKey"],
}
