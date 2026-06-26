import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { embed } from "./embedder"

export interface Chunk {
	id: string
	sourceUrl: string
	title: string
	text: string
	embedding: number[]
}

export interface RetrievedChunk {
	chunk: Chunk
	score: number
}

let index: Chunk[] | null = null

export function resetIndex() {
	index = null
}

function loadIndex(): Chunk[] {
	if (!index) {
		const path = join(process.cwd(), "data", "index.json")
		if (!existsSync(path)) return []
		index = JSON.parse(readFileSync(path, "utf-8")) as Chunk[]
	}
	return index
}

function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0,
		normA = 0,
		normB = 0
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i]
		normA += a[i] * a[i]
		normB += b[i] * b[i]
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// ID статті з URL — щоб дедуплікувати чанки однієї статті
function articleId(url: string): string {
	const match = url.match(/\/(\d{8,})/)
	return match ? match[1] : url
}

export async function retrieve(query: string): Promise<RetrievedChunk[]> {
	return retrieveMulti([query])
}

// Пошук за кількома запитами одночасно (напр. оригінал + переписаний).
// Кожен чанк оцінюється за НАЙКРАЩИМ збігом серед усіх запитів.
export async function retrieveMulti(queries: string[]): Promise<RetrievedChunk[]> {
	const chunks = loadIndex()
	if (chunks.length === 0) return []

	const threshold = Number(process.env.SIMILARITY_THRESHOLD) || 0.4
	const topK = Number(process.env.TOP_K) || 4

	const embeddings = await Promise.all(queries.filter(Boolean).map(q => embed(q)))

	const scored = chunks
		.map(chunk => ({
			chunk,
			score: Math.max(...embeddings.map(e => cosineSimilarity(e, chunk.embedding))),
		}))
		.filter(r => r.score >= threshold)
		.sort((a, b) => b.score - a.score)

	// Диверсифікація: максимум 2 чанки на статтю.
	// Це дає і РІЗНІ статті (покриття), і глибину відповіді в межах статті.
	const perArticle = new Map<string, number>()
	const result: RetrievedChunk[] = []
	for (const r of scored) {
		const id = articleId(r.chunk.sourceUrl)
		const count = perArticle.get(id) ?? 0
		if (count >= 2) continue
		perArticle.set(id, count + 1)
		result.push(r)
		if (result.length >= topK) break
	}
	return result
}
