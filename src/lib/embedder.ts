// Ембединги через Voyage AI API (а не локальну transformers.js-модель).
// Чому: локальна мультимовна модель їсть ~1.6 ГБ RAM — не влазить у Render Free
// (512 МБ). Хмарний API прибирає модель з процесу: на сервері ~0 памʼяті під ембединги.
//
// Модель voyage-3.5-lite — мультимовна (є українська), дешева, у межах free-тарифу.
// output_dimension: 512 — щоб index.json лишався достатньо малим для парсингу в 512 МБ.
// input_type: "query" для питань, "document" для чанків бази (аналог e5 query:/passage:).

const MODEL = "voyage-3.5-lite"
const DIM = 512
const ENDPOINT = "https://api.voyageai.com/v1/embeddings"
const MAX_BATCH = 128 // скільки текстів за один запит (ingest)

async function callVoyage(
	inputs: string[],
	inputType: "query" | "document",
): Promise<number[][]> {
	const key = process.env.VOYAGE_API_KEY
	if (!key) throw new Error("VOYAGE_API_KEY не встановлено у .env")

	for (let attempt = 0; ; attempt++) {
		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${key}`,
			},
			body: JSON.stringify({
				input: inputs,
				model: MODEL,
				input_type: inputType,
				output_dimension: DIM,
			}),
		})

		if (res.ok) {
			const json = (await res.json()) as {
				data: { embedding: number[]; index: number }[]
			}
			// Сортуємо за index — щоб порядок точно збігався з вхідним
			return json.data
				.sort((a, b) => a.index - b.index)
				.map(d => d.embedding)
		}

		// 429 (rate limit) / 5xx — повторюємо з експоненційною паузою
		if ((res.status === 429 || res.status >= 500) && attempt < 6) {
			const wait = Math.min(3000 * 2 ** attempt, 60000)
			console.warn(`[Voyage] ${res.status}, повтор через ${wait}мс...`)
			await new Promise(r => setTimeout(r, wait))
			continue
		}
		throw new Error(`Voyage API ${res.status}: ${await res.text()}`)
	}
}

// Ембединг одного питання користувача (рантайм на сервері)
export async function embed(text: string): Promise<number[]> {
	const [v] = await callVoyage([text], "query")
	return v
}

// Ембединг одного чанка бази (для ingest-curated)
export async function embedPassage(text: string): Promise<number[]> {
	const [v] = await callVoyage([text], "document")
	return v
}

// Батч-ембединг чанків бази (для повного ingest) — авто-розбиття на під-батчі.
// onProgress повертає, скільки вже оброблено, для прогрес-бару.
export async function embedPassages(
	texts: string[],
	onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
	const out: number[][] = []
	for (let i = 0; i < texts.length; i += MAX_BATCH) {
		const batch = texts.slice(i, i + MAX_BATCH)
		const vecs = await callVoyage(batch, "document")
		out.push(...vecs)
		onProgress?.(out.length, texts.length)
	}
	return out
}
