import "dotenv/config"
import { Bot } from "grammy"
import cron from "node-cron"
import { spawn } from "child_process"
import { authMiddleware } from "./middleware/auth"
import { rateLimitMiddleware } from "./middleware/rateLimit"
import { askClaude } from "./lib/claude"
import { resetIndex } from "./lib/retriever"

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.*?)\*\*/gs, "<b>$1</b>")
    .replace(/\*(.*?)\*/gs, "<i>$1</i>")
    .replace(/`(.*?)`/g, "<code>$1</code>")
    .replace(/\[(.*?)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2">$1</a>')
}

function runScript(cmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, { stdio: "inherit", shell: true })
    proc.on("close", code => (code === 0 ? resolve() : reject(new Error(`Exit ${code}`))))
  })
}

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) throw new Error("TELEGRAM_BOT_TOKEN не встановлено у .env")

const bot = new Bot(token)

// /myid і /start доступні без auth
bot.command("myid", ctx =>
  ctx.reply(`Ваш Telegram ID: \`${ctx.from?.id}\``, { parse_mode: "Markdown" }),
)

bot.command("start", ctx =>
  ctx.reply(
    "👋 Вітаю! Я AI-консультант з продуктів банку.\n\n" +
      "Можу відповісти на питання про тарифи, картки, лаунжі та переваги преміум-пакетів.\n\n" +
      "⚠️ *Дисклеймер:* Демонстраційний прототип. Не є офіційним сервісом банку. " +
      "Перевіряйте умови в офіційному застосунку.",
    { parse_mode: "Markdown" },
  ),
)

// Весь інший трафік — тільки для дозволених користувачів
bot.use(authMiddleware)
bot.use(rateLimitMiddleware)

bot.command("help", ctx =>
  ctx.reply(
    "*Що я вмію:*\n\n" +
      "• Відповідати на питання про продукти банку (тарифи, картки, ліміти)\n" +
      "• Розповідати про доступ до лаунжів (Visa, Mastercard, DragonPass)\n" +
      "• Шукати офіційну інформацію на сайтах Visa, Mastercard, НБУ тощо\n\n" +
      "*Приклади питань:*\n" +
      "— Які переваги преміум-картки?\n" +
      "— Чи є доступ до лаунжів з моєю карткою?\n" +
      "— Який ліміт на зняття готівки?\n\n" +
      "Просто напишіть своє питання 👇",
    { parse_mode: "Markdown" },
  ),
)

bot.on("message:text", async ctx => {
  const question = ctx.message.text
  console.log(`[Bot] питання від ${ctx.from?.id}: "${question}"`)

  // Одразу надсилаємо заглушку і запускаємо індикатор
  const waitMsg = await ctx.reply("⏳ Ваше питання в роботі, очікуйте...")
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {})
  }, 4000)

  try {
    const result = await askClaude(question)
    console.log(`[Bot] відповідь (${result.text.length} chars), джерел: ${result.sources.length}`)

    let reply = escapeHtml(result.text)
    if (result.sources.length > 0) {
      const sourcesHtml = result.sources
        .slice(0, 3)
        .map(s => `• <a href="${s.url}">${escapeHtml(s.title)}</a>`)
        .join("\n")
      reply += `\n\n📚 <b>Джерела:</b>\n${sourcesHtml}`
    }

    clearInterval(typingInterval)
    console.log("[Bot] надсилаємо відповідь...")
    await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, reply, {
      parse_mode: "HTML",
    })
    console.log("[Bot] відповідь надіслана ✓")
  } catch (err) {
    clearInterval(typingInterval)
    console.error("[Bot] помилка:", err)
    try {
      await ctx.api.editMessageText(
        ctx.chat.id,
        waitMsg.message_id,
        "⚠️ Виникла помилка. Спробуйте пізніше.",
      )
    } catch (e2) {
      console.error("[Bot] не вдалось оновити повідомлення:", e2)
    }
  }
})

bot.catch(err => {
  console.error("Помилка бота:", err)
})

// Щодня о 5:00 — оновлюємо базу знань
cron.schedule("0 5 * * *", async () => {
  console.log("[Cron] Запуск щоденного оновлення бази...")
  try {
    await runScript("npm run scrape")
    await runScript("npm run ingest")
    resetIndex()
    console.log("[Cron] Базу оновлено ✓")
  } catch (err) {
    console.error("[Cron] Помилка оновлення:", err)
  }
}, { timezone: "Europe/Kyiv" })

bot.start({ drop_pending_updates: true })
console.log("Бот запущено (long polling)...")
