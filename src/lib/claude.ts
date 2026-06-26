import Anthropic from "@anthropic-ai/sdk"
import { ALLOWED_DOMAINS } from "../config/domains"
import { retrieveMulti } from "./retriever"
import type { Turn } from "./conversation"

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

// Витягуємо числовий ID статті для дедуплікації (різні формати URL — один артикул)
function extractArticleId(url: string): string {
	const match = url.match(/\/(\d{8,})/)
	return match ? match[1] : url
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

function buildSystemPrompt(ragContext: string): string {
	const hasContext = ragContext.trim().length > 0

	if (hasContext) {
		return `Ти — AI-консультант з продуктів банку. Відповідай на основі КОНТЕКСТУ з бази знань банку.

Правила:
1. Відповідай тільки з інформації в КОНТЕКСТІ. Не вигадуй.
2. Якщо інформації немає в КОНТЕКСТІ — скажи: «Не знайшов підтвердженої інформації. Перевірте в офіційному застосунку банку.»
3. ВАЖЛИВО: загальна інформація Visa/Mastercard ≠ гарантія для твоєї картки. Додавай: «перевірте умови вашої картки в застосунку».
4. Не називай цифри/ліміти, яких немає в КОНТЕКСТІ.
5. Відповідай українською, коротко.

КОНТЕКСТ:
${ragContext}`
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
	// 1. Шукаємо в локальній базі за кількома запитами:
	//    - оригінал (можливо збагачений попереднім питанням для фоллоу-апів)
	//    - переписаний Haiku (офіційні терміни/синоніми — долає розрив у вокабулярі)
	const baseQuery = prevUserQuestion
		? `${prevUserQuestion} ${userQuestion}`
		: userQuestion
	const rewritten = await rewriteQuery(userQuestion)
	if (rewritten) console.log(`[Rewrite] "${userQuestion}" → "${rewritten}"`)

	const ragResults = await retrieveMulti([baseQuery, rewritten])
	const hasRagResults = ragResults.length > 0

	const ragContext = ragResults
		.map(
			r =>
				`[Джерело: ${r.chunk.title} — ${r.chunk.sourceUrl}]\n${r.chunk.text}`,
		)
		.join("\n\n---\n\n")

	const topScore = ragResults[0]?.score ?? 0
	console.log(
		`[RAG] знайдено ${ragResults.length} чанків, топ скор: ${topScore.toFixed(3)}`,
	)

	// 2. Веб-пошук тільки коли база зовсім нічого не знайшла (передбачувані витрати)
	const needsWebSearch = !hasRagResults
	const tools: Anthropic.Messages.ToolUnion[] = needsWebSearch
		? [
				{
					type: "web_search_20260209",
					name: "web_search",
					max_uses: 1,
					allowed_domains: ALLOWED_DOMAINS,
				} as Anthropic.Messages.WebSearchTool20260209,
		  ]
		: []

	const response = await client.messages.create({
		model: MODEL,
		max_tokens: 1024,
		system: buildSystemPrompt(ragContext),
		...(tools.length > 0 ? { tools } : {}),
		messages: [
			...history.map(t => ({ role: t.role, content: t.content })),
			{ role: "user", content: userQuestion },
		],
	})

	// 3. Парсимо відповідь
	// Збираємо RAG джерела — дедуплікуємо за article ID
	const seenIds = new Set<string>()
	const sources: Source[] = []

	for (const r of ragResults) {
		const id = extractArticleId(r.chunk.sourceUrl)
		if (!seenIds.has(id) && r.chunk.sourceUrl) {
			seenIds.add(id)
			sources.push({ url: r.chunk.sourceUrl, title: r.chunk.title })
		}
	}

	let text = ""
	let usedWebSearch = false

	for (const block of response.content) {
		if (block.type === "text") {
			text += block.text
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

	const finalText =
		text.trim() ||
		"Не вдалося знайти відповідь. Спробуйте переформулювати або зверніться до застосунку банку."

	// Якщо бот не знайшов відповіді — не показуємо нерелевантні джерела
	const finalSources = isNotFoundAnswer(finalText) ? [] : sources

	const usage = response.usage as any
	const webReqs = usage?.server_tool_use?.web_search_requests ?? 0
	console.log(
		`[Claude] in=${usage.input_tokens} out=${usage.output_tokens} | rag=${ragResults.length} web=${webReqs} | sources=${finalSources.length}`,
	)

	return {
		text: finalText,
		sources: finalSources,
		usedWebSearch,
		inputTokens: usage.input_tokens,
		outputTokens: usage.output_tokens,
	}
}
