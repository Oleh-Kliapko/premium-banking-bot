import type { Context } from "grammy"
import { MiddlewareFn } from "grammy"
import { isAuthorized, tryLogin } from "../lib/sessions"

export const authMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
	const userId = ctx.from?.id
	if (!userId) return

	// Вже авторизований — пропускаємо далі
	if (isAuthorized(userId)) return next()

	// Інакше трактуємо повідомлення як спробу ввести логін
	const text = ctx.message?.text
	if (text && tryLogin(userId, text)) {
		await ctx.reply(
			"✅ Доступ надано! Тепер можете поставити своє запитання 👇",
		)
		return
	}

	await ctx.reply(
		"🔒 Цей бот приватний. Введіть, будь ласка, логін для доступу.",
	)
}
