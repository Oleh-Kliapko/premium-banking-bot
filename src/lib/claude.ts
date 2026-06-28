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
5. Відповідай українською, коротко. Спирайся саме на ті документи, що містять відповідь — решту ігноруй.`
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
	// Переписуємо ПОВНИЙ контекстний запит (попереднє + поточне), а не голий
	// фоллоу-ап — інакше уточнення на кшталт «я мав на увазі з кредитного ліміту»
	// втрачає тему («ОВДП») і тягне нерелевантні статті.
	const rewritten = await rewriteQuery(baseQuery)
	if (rewritten) console.log(`[Rewrite] "${baseQuery}" → "${rewritten}"`)

	const ragResults = await retrieveMulti([baseQuery, rewritten])
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

	// 2. Веб-пошук тільки коли база зовсім нічого не знайшла (передбачувані витрати).
	// Базова версія web_search_20250305 — працює на ВСІХ моделях (зокрема Haiku 4.5);
	// динамічна 20260209 потребує 4.6+. allowed_domains підтримується в обох.
	const needsWebSearch = !hasRagResults
	const tools: Anthropic.Messages.ToolUnion[] = needsWebSearch
		? [
				{
					type: "web_search_20250305",
					name: "web_search",
					max_uses: 1,
					allowed_domains: ALLOWED_DOMAINS,
				} as Anthropic.Messages.WebSearchTool20250305,
			]
		: []

	// Поточний хід користувача: документи бази + саме питання
	const userContent: Anthropic.Messages.ContentBlockParam[] = hasRagResults
		? [...docBlocks, { type: "text", text: userQuestion }]
		: [{ type: "text", text: userQuestion }]

	const response = await client.messages.create({
		model: MODEL,
		max_tokens: 1024,
		system: buildSystemPrompt(hasRagResults),
		...(tools.length > 0 ? { tools } : {}),
		messages: [
			...history.map(t => ({ role: t.role, content: t.content })),
			{ role: "user", content: userContent },
		],
	})

	// 3. Парсимо відповідь
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

	// RAG-джерела: беремо ЛИШЕ ті статті, що Claude процитував (дедуп за article ID).
	// Якщо цитат не повернулось, але відповідь змістовна — лишаємо топ-1 чанк
	// як fallback (щоб під відповіддю завжди було хоч одне джерело).
	const citedIndices =
		citedDocs.size > 0
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
