import Anthropic from "@anthropic-ai/sdk"
import { ALLOWED_DOMAINS } from "../config/domains"
import { retrieve } from "./retriever"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6"

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

export async function askClaude(userQuestion: string): Promise<ClaudeResponse> {
	// 1. Шукаємо в локальній базі
	const ragResults = await retrieve(userQuestion)
	const hasRagResults = ragResults.length > 0

	const ragContext = ragResults
		.map(
			r =>
				`[Джерело: ${r.chunk.title} — ${r.chunk.sourceUrl}]\n${r.chunk.text}`,
		)
		.join("\n\n---\n\n")

	console.log(
		`[RAG] знайдено ${ragResults.length} чанків (поріг: ${process.env.SIMILARITY_THRESHOLD || 0.4})`,
	)

	// 2. Веб-пошук тільки якщо RAG нічого не знайшов
	const tools: Anthropic.Messages.ToolUnion[] = hasRagResults
		? []
		: [
				{
					type: "web_search_20260209",
					name: "web_search",
					max_uses: 1,
					allowed_domains: ALLOWED_DOMAINS,
				} as Anthropic.Messages.WebSearchTool20260209,
			]

	const response = await client.messages.create({
		model: MODEL,
		max_tokens: 1024,
		system: buildSystemPrompt(ragContext),
		tools,
		messages: [{ role: "user", content: userQuestion }],
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

	const usage = response.usage as any
	const webReqs = usage?.server_tool_use?.web_search_requests ?? 0
	console.log(
		`[Claude] in=${usage.input_tokens} out=${usage.output_tokens} | rag=${ragResults.length} web=${webReqs}`,
	)

	return {
		text:
			text.trim() ||
			"Не вдалося знайти відповідь. Спробуйте переформулювати або зверніться до застосунку банку.",
		sources,
		usedWebSearch,
		inputTokens: usage.input_tokens,
		outputTokens: usage.output_tokens,
	}
}
