// Підготовка середовища перед стартом бота (актуально для деплою на Render).
import { createServer } from "http"
import { createWriteStream, existsSync, mkdirSync } from "fs"
import { dirname, join } from "path"
import { Readable } from "stream"
import { pipeline } from "stream/promises"

const INDEX_PATH = join(process.cwd(), "data", "index.json")

// Keep-alive HTTP-сервер. Render Web Service вимагає прив'язки до PORT, а
// зовнішній пінгер (cron-job.org) цим же ендпоінтом не дає сервісу заснути.
export function startHealthServer(): void {
	const port = Number(process.env.PORT) || 3000
	createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/plain" })
		res.end("ok")
	}).listen(port, () => console.log(`[Health] слухає порт ${port}`))
}

// Завантажуємо index.json із зовнішнього сховища (INDEX_URL), якщо його нема
// локально. Дозволяє тримати великий індекс поза git (R2 / S3 / GitHub Release).
// Локально (файл є, INDEX_URL порожній) — нічого не качаємо.
export async function ensureIndex(): Promise<void> {
	if (existsSync(INDEX_PATH)) {
		console.log("[Index] локальний index.json знайдено")
		return
	}
	const url = process.env.INDEX_URL
	if (!url) {
		console.warn(
			"[Index] немає index.json і не задано INDEX_URL — база буде порожня",
		)
		return
	}
	console.log("[Index] завантажую index.json із INDEX_URL...")
	mkdirSync(dirname(INDEX_PATH), { recursive: true })
	const res = await fetch(url)
	if (!res.ok || !res.body) throw new Error(`INDEX_URL відповів ${res.status}`)
	// Стрімимо у файл, щоб не тримати 220 МБ у пам'яті під час завантаження
	await pipeline(Readable.fromWeb(res.body as any), createWriteStream(INDEX_PATH))
	console.log("[Index] index.json завантажено ✓")
}
