import { FeatureExtractionPipeline, pipeline } from "@huggingface/transformers"

const MODEL = "intfloat/multilingual-e5-small"
let embedder: FeatureExtractionPipeline | null = null

async function getEmbedder(): Promise<FeatureExtractionPipeline> {
	if (!embedder) {
		console.log("Завантаження моделі ембедингів...")
		embedder = await pipeline("feature-extraction", MODEL)
		console.log("Модель готова.")
	}
	return embedder
}

export async function embed(text: string): Promise<number[]> {
	const model = await getEmbedder()
	const output = await model(`query: ${text}`, {
		pooling: "mean",
		normalize: true,
	})
	return Array.from(output.data as Float32Array)
}

export async function embedPassage(text: string): Promise<number[]> {
	const model = await getEmbedder()
	const output = await model(`passage: ${text}`, {
		pooling: "mean",
		normalize: true,
	})
	return Array.from(output.data as Float32Array)
}
