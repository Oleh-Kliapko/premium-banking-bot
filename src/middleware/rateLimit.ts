import type { Context } from "grammy"
import { MiddlewareFn } from "grammy"

const WINDOW_MS = 60_000
const MAX_REQUESTS = 10
const MAX_INPUT_CHARS = Number(process.env.MAX_INPUT_CHARS) || 1000

const userWindows = new Map<number, { count: number; resetAt: number }>()

export const rateLimitMiddleware: MiddlewareFn<Context> = (ctx, next) => {
	const userId = ctx.from?.id
	if (!userId) return next()

	const text = ctx.message?.text ?? ""
	if (text.length > MAX_INPUT_CHARS) {
		return ctx.reply(
			`⚠️ Повідомлення занадто довге. Максимум ${MAX_INPUT_CHARS} символів.`,
		)
	}

	const now = Date.now()
	const window = userWindows.get(userId)

	if (!window || now > window.resetAt) {
		userWindows.set(userId, { count: 1, resetAt: now + WINDOW_MS })
		return next()
	}

	if (window.count >= MAX_REQUESTS) {
		return ctx.reply("⏳ Забагато запитів. Зачекайте хвилину.")
	}

	window.count++
	return next()
}
