import "dotenv/config"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs"
import { basename, join } from "path"
import { embedPassages } from "../src/lib/embedder"

// ФОП/ЮО (бізнес) статті преміум-менеджер не консультує — не індексуємо їх
// взагалі (менший індекс і дешевший реіндекс). Retriever має ще й свій фільтр.
const BUSINESS_TITLE_RE = /ФОП|ЮО|юридичн|підприємц/i

interface Chunk {
	id: string
	sourceUrl: string
	title: string
	text: string
	embedding: number[]
}

const RAW_DIR = join(process.cwd(), "data", "raw")
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
	if (!match) return { url: "", title: basename(""), body: content }
	const meta = match[1]
	const body = match[2]
	return {
		url: meta.match(/url:\s*(.+)/)?.[1]?.trim() ?? "",
		title: meta.match(/title:\s*(.+)/)?.[1]?.trim() ?? "",
		body,
	}
}

// Прибираємо Zendesk boilerplate, щоб чанки містили лише корисний текст
function cleanBody(text: string): string {
	return text
		.replace(/Contact Us\s*/gi, "")
		.replace(/Автор:\s*.+?Кількість вподобайок:\s*\d+\s*/gs, "")
		.replace(/У цій статті:\s*/gi, "")
		.replace(/Чи була ця стаття корисною\?\s*Так\s*Ні\s*/gi, "")
		.replace(/Give feedback about this article/gi, "")
		.replace(/\s+/g, " ")
		.trim()
}

async function main() {
	if (!existsSync(RAW_DIR)) {
		console.log("❌ Папка data/raw не існує. Спочатку запусти: npm run scrape")
		process.exit(1)
	}

	// Збираємо файли з raw/ (скраплені) та curated/ (ручні документи)
	const rawFiles = readdirSync(RAW_DIR)
		.filter(f => f.endsWith(".md"))
		.map(f => ({ dir: RAW_DIR, file: f }))
	const curatedFiles = existsSync(CURATED_DIR)
		? readdirSync(CURATED_DIR)
				.filter(f => f.endsWith(".md"))
				.map(f => ({ dir: CURATED_DIR, file: f }))
		: []
	const files = [...curatedFiles, ...rawFiles]

	if (files.length === 0) {
		console.log("❌ Немає файлів у data/raw/. Спочатку запусти: npm run scrape")
		process.exit(1)
	}

	console.log(
		`📂 Файлів для індексації: ${files.length} (curated: ${curatedFiles.length}, raw: ${rawFiles.length})`,
	)

	// 1. Збираємо всі чанки (без ембедингів), пропускаючи ФОП/ЮО та ДУБЛІКАТИ.
	// Сайт скрапиться під кількома URL → той самий текст повторюється ~3 рази;
	// без дедупу дублікати зʼїдають слоти пошуку й витісняють реальний контент.
	const pending: Omit<Chunk, "embedding">[] = []
	const seenTexts = new Set<string>()
	let skipped = 0
	let dups = 0
	for (const { dir, file } of files) {
		const content = readFileSync(join(dir, file), "utf-8")
		const { url, title, body } = parseMeta(content)
		const isCurated = dir === CURATED_DIR
		if (!isCurated && BUSINESS_TITLE_RE.test(title)) {
			skipped++
			continue
		}
		const parts = splitIntoChunks(cleanBody(body))
		parts.forEach((p, i) => {
			const text = p.trim()
			if (seenTexts.has(text)) {
				dups++
				return
			}
			seenTexts.add(text)
			pending.push({
				id: `${basename(file, ".md")}-${i}`,
				sourceUrl: url,
				title: title || basename(file),
				text,
			})
		})
	}
	console.log(
		`✂️  Чанків до ембедингу: ${pending.length} (ФОП/ЮО статей: ${skipped}, дублікатів прибрано: ${dups})`,
	)

	// 2. Ембединг батчами через Voyage
	const embeddings = await embedPassages(
		pending.map(p => p.text),
		(done, total) => process.stdout.write(`\r🧮 Ембединг: ${done}/${total}`),
	)

	// 3. Зшиваємо метадані + вектори
	const allChunks: Chunk[] = pending.map((p, i) => ({
		...p,
		embedding: embeddings[i],
	}))

	writeFileSync(INDEX_PATH, JSON.stringify(allChunks))
	console.log(`\n\n✅ Збережено ${allChunks.length} чанків → data/index.json`)
}

main().catch(err => {
	console.error("❌ Помилка ingest:", err)
	process.exit(1)
})
