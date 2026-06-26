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

export async function retrieve(query: string): Promise<RetrievedChunk[]> {
	const chunks = loadIndex()
	if (chunks.length === 0) return []

	const threshold = Number(process.env.SIMILARITY_THRESHOLD) || 0.4
	const topK = Number(process.env.TOP_K) || 4

	const queryEmbedding = await embed(query)

	return chunks
		.map(chunk => ({
			chunk,
			score: cosineSimilarity(queryEmbedding, chunk.embedding),
		}))
		.filter(r => r.score >= threshold)
		.sort((a, b) => b.score - a.score)
		.slice(0, topK)
}
