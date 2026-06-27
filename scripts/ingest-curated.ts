import "dotenv/config"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { basename, join } from "path"
import { embedPassage } from "../src/lib/embedder"

// Швидка інкрементальна індексація ТІЛЬКИ curated-документів.
// Видаляє старі чанки цих документів з index.json і додає нові —
// щоб не переіндексовувати всю скраплену базу (~20 хв) заради ручної правки.

interface Chunk {
	id: string
	sourceUrl: string
	title: string
	text: string
	embedding: number[]
}

const CURATED_DIR = join(process.cwd(), "data", "curated")
const INDEX_PATH = join(process.cwd(), "data", "index.json")
const CHUNK_SIZE = 600
const OVERLAP = 100

function splitIntoChunks(text: string): string[] {
	const chunks: string[] = []
	let start = 0
	while (start < text.length) {
		chunks.push(text.slice(start, start + CHUNK_SIZE))
		start += CHUNK_SIZE - OVERLAP
	}
	return chunks.filter(c => c.trim().length > 50)
}

function parseMeta(content: string): {
	url: string
	title: string
	body: string
} {
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
	if (!match) return { url: "", title: "", body: content }
	const meta = match[1]
	return {
		url: meta.match(/url:\s*(.+)/)?.[1]?.trim() ?? "",
		title: meta.match(/title:\s*(.+)/)?.[1]?.trim() ?? "",
		body: match[2],
	}
}

async function main() {
	if (!existsSync(CURATED_DIR)) {
		console.log("❌ Немає папки data/curated/")
		process.exit(1)
	}
	if (!existsSync(INDEX_PATH)) {
		console.log(
			"❌ Немає data/index.json. Спочатку запусти повний npm run ingest",
		)
		process.exit(1)
	}

	const curatedFiles = readdirSync(CURATED_DIR).filter(f => f.endsWith(".md"))
	if (curatedFiles.length === 0) {
		console.log("⚠️  Немає curated-документів")
		return
	}

	const index: Chunk[] = JSON.parse(readFileSync(INDEX_PATH, "utf-8"))

	// Збираємо URL усіх curated-документів — щоб видалити їхні старі чанки
	const curatedUrls = new Set<string>()
	const newChunks: Chunk[] = []

	for (const file of curatedFiles) {
		const content = readFileSync(join(CURATED_DIR, file), "utf-8")
		const { url, title, body } = parseMeta(content)
		if (url) curatedUrls.add(url)

		const parts = splitIntoChunks(body.trim().replace(/\s+/g, " "))
		console.log(`📄 ${file} → ${parts.length} чанків`)

		for (let i = 0; i < parts.length; i++) {
			const text = parts[i].trim()
			const embedding = await embedPassage(text)
			newChunks.push({
				id: `curated-${basename(file, ".md")}-${i}`,
				sourceUrl: url,
				title: title || basename(file),
				text,
				embedding,
			})
		}
	}

	// Видаляємо старі чанки curated-документів і додаємо нові
	const kept = index.filter(c => !curatedUrls.has(c.sourceUrl))
	const updated = [...newChunks, ...kept]

	writeFileSync(INDEX_PATH, JSON.stringify(updated))
	console.log(
		`\n✅ Оновлено: ${newChunks.length} curated-чанків, всього в індексі ${updated.length}`,
	)
}

main().catch(err => {
	console.error("❌ Помилка:", err)
	process.exit(1)
})
