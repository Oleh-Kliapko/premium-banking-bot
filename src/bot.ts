import "dotenv/config"
import { Bot, InlineKeyboard, type Context } from "grammy"
import cron from "node-cron"
import { spawn } from "child_process"
import { authMiddleware } from "./middleware/auth"
import { rateLimitMiddleware } from "./middleware/rateLimit"
import { isAuthorized, initSessions } from "./lib/sessions"
import { ensureIndex, startHealthServer } from "./lib/bootstrap"
import { askClaude } from "./lib/claude"
import { resetIndex } from "./lib/retriever"
import {
  getHistory,
  addTurn,
  clearHistory,
  lastUserQuestion,
  setPending,
  takePending,
  getShownSources,
  recordShownSources,
} from "./lib/conversation"

// ID статті з URL (останнє 8+-значне число) — ключ для дедуплікації джерел
function articleIdFromUrl(url: string): string {
  const nums = url.match(/\d{8,}/g)
  return nums ? nums[nums.length - 1] : url
}

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

bot.command("start", ctx => {
  if (ctx.from) clearHistory(ctx.from.id)
  // Неавторизований — просимо логін (доступ закритий)
  if (!ctx.from || !isAuthorized(ctx.from.id)) {
    return ctx.reply(
      "🔒 Це приватний бот. Щоб отримати доступ, надішліть, будь ласка, ваш логін.",
    )
  }
  return ctx.reply(
    "👋 Вітаю! Я AI-консультант з продуктів банку.\n\n" +
      "Можу відповісти на питання про тарифи, картки, лаунжі та переваги преміум-пакетів.\n\n" +
      "⚠️ *Дисклеймер:* Демонстраційний прототип. Не є офіційним сервісом банку. " +
      "Перевіряйте умови в офіційному застосунку.",
    { parse_mode: "Markdown" },
  )
})

// Весь інший трафік — тільки для дозволених користувачів
bot.use(authMiddleware)
bot.use(rateLimitMiddleware)

bot.command("reset", ctx => {
  if (ctx.from) clearHistory(ctx.from.id)
  return ctx.reply("🔄 Контекст розмови очищено. Можете почати нову тему.")
})

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

// Обробка питання: RAG + Claude → відповідь у Telegram
async function handleQuestion(ctx: Context, userId: number, question: string, useContext: boolean) {
  const waitMsg = await ctx.reply("⏳ Ваше питання в роботі, очікуйте...")
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {})
  }, 4000)

  try {
    const history = useContext ? getHistory(userId) : []
    const prevQuestion = useContext ? lastUserQuestion(userId) : ""
    const result = await askClaude(question, history, prevQuestion)

    addTurn(userId, "user", question)
    addTurn(userId, "assistant", result.text)

    // У межах однієї теми не дублюємо вже показані джерела — лишаємо лише нові
    const shown = getShownSources(userId)
    const newSources = result.sources
      .filter(s => !shown.has(articleIdFromUrl(s.url)))
      .slice(0, 3)
    console.log(
      `[Bot] відповідь (${result.text.length} chars), джерел: ${result.sources.length}, нових: ${newSources.length}`,
    )

    let reply = escapeHtml(result.text)
    if (newSources.length > 0) {
      const sourcesHtml = newSources
        .map(s => `• <a href="${s.url}">${escapeHtml(s.title)}</a>`)
        .join("\n")
      reply += `\n\n📚 <b>Джерела:</b>\n${sourcesHtml}`
      recordShownSources(userId, newSources.map(s => articleIdFromUrl(s.url)))
    }

    clearInterval(typingInterval)
    await ctx.api.editMessageText(ctx.chat!.id, waitMsg.message_id, reply, {
      parse_mode: "HTML",
    })
    console.log("[Bot] відповідь надіслана ✓")
  } catch (err) {
    clearInterval(typingInterval)
    console.error("[Bot] помилка:", err)
    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        waitMsg.message_id,
        "⚠️ Виникла помилка. Спробуйте пізніше.",
      )
    } catch (e2) {
      console.error("[Bot] не вдалось оновити повідомлення:", e2)
    }
  }
}

bot.on("message:text", async ctx => {
  const question = ctx.message.text
  const userId = ctx.from!.id
  console.log(`[Bot] питання від ${userId}: "${question}"`)

  // Перше питання в розмові — обробляємо одразу
  if (getHistory(userId).length === 0) {
    await handleQuestion(ctx, userId, question, false)
    return
  }

  // Є контекст → питаємо нове це питання чи продовження
  setPending(userId, question)
  const keyboard = new InlineKeyboard()
    .text("🆕 Нове питання", "ctx_new")
    .text("↪️ Продовження теми", "ctx_continue")
  await ctx.reply("Це нове питання чи продовження попередньої теми?", {
    reply_markup: keyboard,
  })
})

bot.callbackQuery("ctx_new", async ctx => {
  await ctx.answerCallbackQuery()
  const userId = ctx.from.id
  const question = takePending(userId)
  await ctx.editMessageText("🆕 Нова тема").catch(() => {})
  if (!question) return
  clearHistory(userId)
  await handleQuestion(ctx, userId, question, false)
})

bot.callbackQuery("ctx_continue", async ctx => {
  await ctx.answerCallbackQuery()
  const userId = ctx.from.id
  const question = takePending(userId)
  await ctx.editMessageText("↪️ Продовжуємо тему").catch(() => {})
  if (!question) return
  await handleQuestion(ctx, userId, question, true)
})

bot.catch(err => {
  console.error("Помилка бота:", err)
})

// Щодня о 5:00 — оновлюємо базу знань.
// На сервері (Render Free) вимикаємо через DISABLE_CRON=1: scrape+ingest надто
// важкі для 512 МБ, а новий індекс там ефемерний. Оновлення робимо локально
// (scrape+ingest → завантажити index.json у сховище), сервер його лише качає.
if (process.env.DISABLE_CRON) {
  console.log("[Cron] вимкнено (DISABLE_CRON)")
} else {
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
}

// Старт полінгу з м'яким ретраєм на 409 Conflict. Під час zero-downtime деплою
// Render тримає старий інстанс живим, поки новий стартує, — обидва на мить
// смикають getUpdates, і Telegram віддає 409. Замість падіння новий інстанс
// чекає й повторює, поки старий не звільнить полінг.
async function startPolling(maxAttempts = 12, delayMs = 5000): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        drop_pending_updates: true,
        onStart: () => console.log("Бот запущено (long polling)..."),
      })
      return // штатна зупинка через bot.stop()
    } catch (err) {
      const code = (err as { error_code?: number })?.error_code
      if (code === 409 && attempt < maxAttempts) {
        console.warn(
          `[Polling] 409 Conflict (інший інстанс ще живий) — спроба ${attempt}/${maxAttempts}, чекаю ${delayMs / 1000}с...`,
        )
        await new Promise(r => setTimeout(r, delayMs))
        continue
      }
      throw err // не 409 або вичерпано спроби — хай впаде, щоб помітити
    }
  }
}

async function bootstrap() {
  // 1. Біндимо PORT одразу — Render має побачити відкритий порт швидко
  startHealthServer()
  // 2. Підтягуємо індекс із зовнішнього сховища (якщо треба)
  try {
    await ensureIndex()
  } catch (e) {
    console.error("[Index] помилка завантаження:", e)
  }
  // 3. Завантажуємо авторизованих (Redis/файл)
  try {
    await initSessions()
  } catch (e) {
    console.error("[Sessions] init:", e)
  }
  // 4. Стартуємо полінг (з ретраєм на 409 під час перекриття деплоїв)
  await startPolling()
}

bootstrap()
