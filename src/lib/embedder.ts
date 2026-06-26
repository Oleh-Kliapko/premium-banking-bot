import { FeatureExtractionPipeline, pipeline } from "@huggingface/transformers"

const MODEL = "intfloat/multilingual-e5-small"
// Кешуємо ПРОМІС, а не результат — щоб паралельні виклики (retrieveMulti)
// не запускали завантаження моделі двічі (race condition)
let embedderPromise: Promise<FeatureExtractionPipeline> | null = null

function getEmbedder(): Promise<FeatureExtractionPipeline> {
	if (!embedderPromise) {
		console.log("Завантаження моделі ембедингів...")
		embedderPromise = pipeline("feature-extraction", MODEL).then(p => {
			console.log("Модель готова.")
			return p
		})
	}
	return embedderPromise
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
