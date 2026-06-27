import { load } from "cheerio"
import { createHash } from "crypto"
import "dotenv/config"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

const SITEMAP_URL = "https://help.sensebank.com.ua/sitemap.xml"
const RAW_DIR = join(process.cwd(), "data", "raw")
const META_PATH = join(process.cwd(), "data", "pages-meta.json")
const DELAY_MS = 500

interface PageMeta {
	lastModified: string | null
	contentHash: string
	scrapedAt: string
	title: string
}
type MetaStore = Record<string, PageMeta>

function loadMeta(): MetaStore {
	if (existsSync(META_PATH)) {
		return JSON.parse(readFileSync(META_PATH, "utf-8"))
	}
	return {}
}

function saveMeta(meta: MetaStore) {
	writeFileSync(META_PATH, JSON.stringify(meta, null, 2))
}

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchSitemapUrls(): Promise<string[]> {
	console.log("📡 Завантажуємо sitemap...")
	const res = await fetch(SITEMAP_URL)
	const xml = await res.text()
	const $ = load(xml, { xmlMode: true })
	const urls: string[] = []
	$("url > loc").each((_, el) => {
		const url = $(el).text().trim()
		// Беремо тільки українські статті
		if (url.includes("/uk_UA/") || url.includes("/uk_UA")) {
			urls.push(url)
		}
	})
	console.log(`📋 Знайдено ${urls.length} українських URL`)
	return urls
}

async function headCheck(url: string): Promise<string | null> {
	try {
		const res = await fetch(url, { method: "HEAD" })
		return res.headers.get("last-modified")
	} catch {
		return null
	}
}

async function scrapePage(
	url: string,
): Promise<{ title: string; text: string } | null> {
	try {
		const res = await fetch(url, {
			headers: { "Accept-Language": "uk-UA,uk;q=0.9" },
		})
		if (!res.ok) return null
		const html = await res.text()
		const $ = load(html)

		// Zendesk article selectors
		const title =
			$("h1.article-header__title").first().text().trim() ||
			$("h1").first().text().trim() ||
			$("title")
				.text()
				.replace(/ – .*$/, "")
				.trim()

		const body =
			$("div.article-body").text().trim() ||
			$('[itemprop="articleBody"]').text().trim() ||
			$("article").text().trim()

		if (!body) return null

		// Чистимо зайві пробіли
		const text = body.replace(/\s+/g, " ").trim()
		return { title, text }
	} catch {
		return null
	}
}

function urlToFilename(url: string): string {
	// SHA256 перших 16 символів — завжди короткий і унікальний
	return `${createHash("sha256").update(url).digest("hex").slice(0, 16)}.md`
}

function contentHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

export async function scrapeAll() {
	mkdirSync(RAW_DIR, { recursive: true })
	const meta = loadMeta()
	const urls = await fetchSitemapUrls()

	let scraped = 0
	let skipped = 0
	let errors = 0

	for (let i = 0; i < urls.length; i++) {
		const url = urls[i]
		process.stdout.write(`\r[${i + 1}/${urls.length}] ${url.slice(-60)}`)

		const existing = meta[url]
		const lastMod = await headCheck(url)

		// Перевіряємо чи потрібно оновлювати
		if (existing && lastMod && existing.lastModified === lastMod) {
			skipped++
			await sleep(50)
			continue
		}

		await sleep(DELAY_MS)
		const page = await scrapePage(url)

		if (!page) {
			errors++
			continue
		}

		const hash = contentHash(page.text)

		// Якщо hash не змінився — теж пропускаємо
		if (existing && existing.contentHash === hash) {
			skipped++
			meta[url] = {
				...existing,
				lastModified: lastMod,
				scrapedAt: new Date().toISOString(),
			}
			continue
		}

		// Зберігаємо сторінку
		const filename = urlToFilename(url)
		const content = `---\nurl: ${url}\ntitle: ${page.title}\n---\n\n${page.text}`
		writeFileSync(join(RAW_DIR, filename), content, "utf-8")

		meta[url] = {
			lastModified: lastMod,
			contentHash: hash,
			scrapedAt: new Date().toISOString(),
			title: page.title,
		}
		scraped++
	}

	saveMeta(meta)
	console.log(
		`\n\n✅ Готово: оновлено ${scraped}, пропущено ${skipped}, помилок ${errors}`,
	)
	return { scraped, skipped, errors }
}

// Запуск напряму
scrapeAll().catch(err => {
	console.error("❌ Помилка scrape:", err)
	process.exit(1)
})
