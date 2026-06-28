import Anthropic from "@anthropic-ai/sdk"
import { ALLOWED_DOMAINS } from "../config/domains"
import type { Turn } from "./conversation"
import { retrieveMulti } from "./retriever"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6"
const REWRITE_MODEL = "claude-haiku-4-5" // дешева модель для переписування запиту

// Переписуємо природне питання на пошуковий запит з офіційними термінами/синонімами.
// Допомагає подолати розрив у вокабулярі (напр. "бізнес зал" → "бізнес-лаунж аеропорт").
async function rewriteQuery(question: string): Promise<string> {
	try {
		const r = await client.messages.create({
			model: REWRITE_MODEL,
			max_tokens: 80,
			system:
				"Перетвори питання клієнта банку на короткий пошуковий запит для бази знань. " +
				"Додай офіційні банківські терміни та синоніми (напр. 'бізнес зал' → 'бізнес-лаунж аеропорт Visa Airport Companion'; " +
				"'переваги' → 'умови переваги'). Поверни ТІЛЬКИ ключові слова через пробіл, без пояснень, українською.",
			messages: [{ role: "user", content: question }],
		})
		const block = r.content[0]
		return block?.type === "text" ? block.text.trim() : ""
	} catch (e) {
		console.error("[Rewrite] помилка, використовуємо оригінал:", e)
		return ""
	}
}

export interface Source {
	url: string
	title: string
}

export interface ClaudeResponse {
	text: string
	sources: Source[]
	usedWebSearch: boolean
	inputTokens: number
	outputTokens: number
}

// Витягуємо числовий ID статті для дедуплікації джерел.
// URL: /uk_UA/{секція}/{стаття} — беремо ОСТАННЄ 8+-значне число (ID статті),
// інакше різні статті однієї секції склеюються в одне джерело.
function extractArticleId(url: string): string {
	const nums = url.match(/\d{8,}/g)
	return nums ? nums[nums.length - 1] : url
}

// Склеюємо весь текст відповіді (щоб перевірити, чи база сказала «не знайшов»)
function concatText(content: Anthropic.Messages.ContentBlock[]): string {
	let t = ""
	for (const b of content) if (b.type === "text") t += b.text
	return t
}

// Чи відповідь — це "не знайшов" / м'яка відмова (тоді джерела показувати немає сенсу)
function isNotFoundAnswer(text: string): boolean {
	const lower = text.toLowerCase()
	const markers = [
		"не знайшов підтвердженої",
		"не маю підтвердженої",
		"не маю інформації",
		"немає підтвердженої",
		"не можу надати", // "не можу надати точну відповідь / інформацію"
		"не можу відповісти",
		"контекст не містить",
		"не містить конкретної інформації",
		"немає інформації",
	]
	return markers.some(m => lower.includes(m))
}

function buildSystemPrompt(hasContext: boolean): string {
	if (hasContext) {
		return `Ти — AI-консультант з продуктів банку. Відповідай на основі ДОДАНИХ ДОКУМЕНТІВ з бази знань банку.

Правила:
1. Відповідай тільки з інформації в доданих документах. Не вигадуй.
2. Якщо інформації немає в документах — скажи: «Не знайшов підтвердженої інформації. Перевірте в офіційному застосунку банку.»
3. ВАЖЛИВО: загальна інформація Visa/Mastercard ≠ гарантія для твоєї картки. Додавай: «перевірте умови вашої картки в застосунку».
4. Не називай цифри/ліміти, яких немає в документах.
5. УВАЖНО розрізняй умови за каналами та типами (напр. «в застосунку Sense SuperApp» vs «поза застосунком», за власні кошти vs за кредитний ліміт). НЕ змішуй і НЕ переноси умову одного каналу на інший.
6. Пиши ЧИСТОЮ українською мовою, без русизмів (напр. «стосується», а не «касається»; «застосунок», а не «додаток»). Коротко й людською мовою. Спирайся лише на документи з відповіддю — решту ігноруй.`
	}

	return `Ти — AI-консультант з продуктів банку. Локальна база не містить відповіді — скористайся веб-пошуком по офіційних доменах.

Правила:
1. Шукай тільки на офіційних доменах (банк, Visa, Mastercard, НБУ).
2. Якщо не знайдено — скажи: «Не маю підтвердженої інформації, перевірте в застосунку банку.»
3. ВАЖЛИВО: загальна інформація Visa/Mastercard ≠ персональне право. Додавай: «перевірте умови вашої картки в застосунку».
4. Відповідай українською, коротко.`
}

export async function askClaude(
	userQuestion: string,
	history: Turn[] = [],
	prevUserQuestion = "",
): Promise<ClaudeResponse> {
	// 1. Шукаємо в локальній базі за кількома запитами.
	// Запит будуємо з ВІКНА теми — кількох останніх питань користувача, а не
	// лише попереднього. Інакше після 2 розпливчастих фоллоу-апів губиться тема
	// (напр. «ОВДП»), RAG порожніє і спрацьовує дорогий web_search.
	const recentUserQs = history
		.filter(t => t.role === "user")
		.map(t => t.content)
		.slice(-2)
	const topicQs = recentUserQs.length
		? recentUserQs
		: prevUserQuestion
			? [prevUserQuestion]
			: []
	const baseQuery = [...topicQs, userQuestion].join(" ").trim()
	// Переписуємо контекстний запит Haiku (офіційні терміни/синоніми)
	const rewritten = await rewriteQuery(baseQuery)
	if (rewritten) console.log(`[Rewrite] "${baseQuery}" → "${rewritten}"`)

	// Запити пошуку: контекстний (тема) + переписаний + ГОЛЕ поточне питання.
	// Голе питання ловить специфічний намір поточного ходу (напр. «розмір
	// компенсації»), який інакше розчиняється в накопиченому контексті теми.
	const queries = [
		...new Set([baseQuery, rewritten, userQuestion].filter(Boolean)),
	]
	const ragResults = await retrieveMulti(queries)
	const hasRagResults = ragResults.length > 0

	// Кожен знайдений чанк передаємо як окремий document-блок з увімкненими
	// нативними цитатами. Так Claude сам позначає, який документ реально
	// використав, і в джерела потрапляють ЛИШЕ процитовані статті (а не весь
	// топ-K з його випадковим вокабулярним шумом).
	const docBlocks: Anthropic.Messages.ContentBlockParam[] = ragResults.map(
		r => ({
			type: "document",
			source: {
				type: "text",
				media_type: "text/plain",
				data: r.chunk.text,
			},
			title: r.chunk.title,
			citations: { enabled: true },
		}),
	)

	const topScore = ragResults[0]?.score ?? 0
	console.log(
		`[RAG] знайдено ${ragResults.length} чанків, топ скор: ${topScore.toFixed(3)}`,
	)

	// 2. Веб-пошук — лише коли база зовсім нічого не знайшла. Дорогий (один пошук
	// додає ~15-20К вхідних токенів), тож вимикабельний: WEB_SEARCH_MAX_USES=0
	// повністю прибирає fallback (RAG-порожньо → чесне «не знаю»).
	// Базова web_search_20250305 працює на ВСІХ моделях (зокрема Haiku 4.5).
	const webMaxUses = Number(process.env.WEB_SEARCH_MAX_USES ?? 1)
	let totalIn = 0
	let totalOut = 0

	// ---- Прохід 1: база (лише якщо взагалі є чанки) ----
	let response: Anthropic.Messages.Message | undefined
	let fromWeb = false
	if (hasRagResults) {
		response = await client.messages.create({
			model: MODEL,
			max_tokens: 1024,
			system: buildSystemPrompt(true),
			messages: [
				...history.map(t => ({ role: t.role, content: t.content })),
				{
					role: "user",
					content: [...docBlocks, { type: "text", text: userQuestion }],
				},
			],
		})
		totalIn += response.usage.input_tokens
		totalOut += response.usage.output_tokens
		console.log(
			`[Claude] прохід=база model=${MODEL} in=${response.usage.input_tokens} out=${response.usage.output_tokens} | rag=${ragResults.length}`,
		)
	}

	// База не дала відповіді: або чанків не було, або Claude явно сказав
	// «не знайшов у документах» → пробуємо веб (якщо ввімкнено).
	const baseText = response ? concatText(response.content) : ""
	const baseFailed = !hasRagResults || isNotFoundAnswer(baseText)

	// ---- Прохід 2: веб-пошук по офіційних доменах (без марних чанків бази) ----
	if (baseFailed && webMaxUses > 0) {
		const webResponse = await client.messages.create({
			model: MODEL,
			max_tokens: 1024,
			system: buildSystemPrompt(false),
			tools: [
				{
					type: "web_search_20250305",
					name: "web_search",
					max_uses: webMaxUses,
					allowed_domains: ALLOWED_DOMAINS,
				} as Anthropic.Messages.WebSearchTool20250305,
			],
			messages: [
				...history.map(t => ({ role: t.role, content: t.content })),
				{ role: "user", content: userQuestion },
			],
		})
		totalIn += webResponse.usage.input_tokens
		totalOut += webResponse.usage.output_tokens
		const webReqs =
			(webResponse.usage as any)?.server_tool_use?.web_search_requests ?? 0
		console.log(
			`[Claude] прохід=веб model=${MODEL} in=${webResponse.usage.input_tokens} out=${webResponse.usage.output_tokens} | web=${webReqs}`,
		)
		response = webResponse
		fromWeb = true
	}

	// Ні база, ні веб не дали відповіді (RAG порожній + веб вимкнено) → «не знаю»
	if (!response) {
		return {
			text: "Не маю підтвердженої інформації. Перевірте, будь ласка, в офіційному застосунку банку.",
			sources: [],
			usedWebSearch: false,
			inputTokens: totalIn,
			outputTokens: totalOut,
		}
	}

	// 3. Парсимо фінальну відповідь
	const seenIds = new Set<string>()
	const sources: Source[] = []
	const citedDocs = new Set<number>() // індекси процитованих document-блоків

	let text = ""
	let usedWebSearch = false

	for (const block of response.content) {
		if (block.type === "text") {
			text += block.text
			// Збираємо індекси документів, які Claude реально процитував
			const citations = (block as any).citations
			if (Array.isArray(citations)) {
				for (const c of citations) {
					if (typeof c.document_index === "number") {
						citedDocs.add(c.document_index)
					}
				}
			}
		} else if (block.type === "web_search_tool_result") {
			usedWebSearch = true
			const content = (block as any).content
			if (Array.isArray(content)) {
				for (const item of content) {
					if (item.type === "web_search_result" && item.url) {
						const id = extractArticleId(item.url)
						if (!seenIds.has(id)) {
							seenIds.add(id)
							sources.push({ url: item.url, title: item.title ?? item.url })
						}
					}
				}
			}
		}
	}

	// RAG-джерела — ЛИШЕ якщо відповідь із БАЗИ (не з вебу): беремо ті статті,
	// що Claude процитував (дедуп за article ID). Немає цитат, але відповідь
	// змістовна → лишаємо топ-1 чанк як fallback (щоб було хоч одне джерело).
	const citedIndices = fromWeb
		? []
		: citedDocs.size > 0
			? [...citedDocs].sort((a, b) => a - b)
			: hasRagResults
				? [0]
				: []
	for (const i of citedIndices) {
		const chunk = ragResults[i]?.chunk
		if (!chunk?.sourceUrl) continue
		const id = extractArticleId(chunk.sourceUrl)
		if (!seenIds.has(id)) {
			seenIds.add(id)
			sources.push({ url: chunk.sourceUrl, title: chunk.title })
		}
	}

	const finalText =
		text.trim() ||
		"Не вдалося знайти відповідь. Спробуйте переформулювати або зверніться до застосунку банку."

	// Якщо бот не знайшов відповіді — не показуємо нерелевантні джерела
	const finalSources = isNotFoundAnswer(finalText) ? [] : sources

	console.log(
		`[Claude] разом in=${totalIn} out=${totalOut} | джерело=${fromWeb ? "веб" : "база"} | sources=${finalSources.length}`,
	)

	return {
		text: finalText,
		sources: finalSources,
		usedWebSearch,
		inputTokens: totalIn,
		outputTokens: totalOut,
	}
}
