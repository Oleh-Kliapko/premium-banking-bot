import "dotenv/config"
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs"
import { join, basename } from "path"
import { embedPassage } from "../src/lib/embedder"

interface Chunk {
  id: string
  sourceUrl: string
  title: string
  text: string
  embedding: number[]
}

const RAW_DIR = join(process.cwd(), "data", "raw")
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

function parseMeta(content: string): { url: string; title: string; body: string } {
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

  const files = readdirSync(RAW_DIR).filter(f => f.endsWith(".md"))
  if (files.length === 0) {
    console.log("❌ Немає файлів у data/raw/. Спочатку запусти: npm run scrape")
    process.exit(1)
  }

  console.log(`📂 Файлів для індексації: ${files.length}`)
  const allChunks: Chunk[] = []

  for (let f = 0; f < files.length; f++) {
    const file = files[f]
    process.stdout.write(`\r[${f + 1}/${files.length}] ${file}`)
    const content = readFileSync(join(RAW_DIR, file), "utf-8")
    const { url, title, body } = parseMeta(content)
    const parts = splitIntoChunks(cleanBody(body))

    for (let i = 0; i < parts.length; i++) {
      const text = parts[i].trim()
      const embedding = await embedPassage(text)
      allChunks.push({
        id: `${basename(file, ".md")}-${i}`,
        sourceUrl: url,
        title: title || basename(file),
        text,
        embedding,
      })
    }
  }

  writeFileSync(INDEX_PATH, JSON.stringify(allChunks, null, 2))
  console.log(`\n\n✅ Збережено ${allChunks.length} чанків → data/index.json`)
}

main().catch(err => {
  console.error("❌ Помилка ingest:", err)
  process.exit(1)
})
