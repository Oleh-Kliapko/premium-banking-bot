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

// Статті для ФОП/ЮО (бізнес) — преміум-менеджер ними не займається і не
// консультує. Виключаємо їх повністю: ні в контекст для Claude, ні в джерела.
// Маркери надійні: Zendesk ставить у title префікс "ФОП."/"ФОП/ЮО."/"ЮО." або
// слова "юридичн"/"підприємц". Перевірено — преміум-роздрібні статті не зачіпає.
const BUSINESS_TITLE_RE = /ФОП|ЮО|юридичн|підприємц/i

function isBusinessArticle(title: string): boolean {
	return BUSINESS_TITLE_RE.test(title)
}

function loadIndex(): Chunk[] {
	if (!index) {
		const path = join(process.cwd(), "data", "index.json")
		if (!existsSync(path)) return []
		const all = JSON.parse(readFileSync(path, "utf-8")) as Chunk[]
		index = all.filter(c => !isBusinessArticle(c.title))
		const removed = all.length - index.length
		console.log(
			`[Index] завантажено ${index.length} чанків (виключено ${removed} ФОП/ЮО)`,
		)
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

// ID статті з URL — щоб дедуплікувати чанки однієї статті.
// URL: /uk_UA/{секція}/{стаття} — беремо ОСТАННЄ 8+-значне число (ID статті).
// Раніше бралося перше → склеювало всі статті однієї секції в одну (втрата recall).
function articleId(url: string): string {
	const nums = url.match(/\d{8,}/g)
	return nums ? nums[nums.length - 1] : url
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
	const perArticleCap = Number(process.env.CHUNKS_PER_ARTICLE) || 1

	const embeddings = await Promise.all(queries.filter(Boolean).map(q => embed(q)))

	const scored = chunks
		.map(chunk => ({
			chunk,
			score: Math.max(...embeddings.map(e => cosineSimilarity(e, chunk.embedding))),
		}))
		.filter(r => r.score >= threshold)
		.sort((a, b) => b.score - a.score)

	// Диверсифікація: максимум perArticleCap чанків на статтю.
	// Ландшафт косинусних скорів дуже плаский (десятки статей у межах ~0.02),
	// тож потрібна ШИРОТА покриття: беремо по 1 найкращому чанку з якомога
	// більшої кількості РІЗНИХ статей. Зайві статті не шкодять джерелам —
	// у джерела (claude.ts) потрапляє лише те, що Claude реально процитував.
	const perArticle = new Map<string, number>()
	const result: RetrievedChunk[] = []
	for (const r of scored) {
		const id = articleId(r.chunk.sourceUrl)
		const count = perArticle.get(id) ?? 0
		if (count >= perArticleCap) continue
		perArticle.set(id, count + 1)
		result.push(r)
		if (result.length >= topK) break
	}
	return result
}
