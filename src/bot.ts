import "dotenv/config"
import { Bot } from "grammy"
import { authMiddleware } from "./middleware/auth"
import { rateLimitMiddleware } from "./middleware/rateLimit"

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) throw new Error("TELEGRAM_BOT_TOKEN не встановлено у .env")

const bot = new Bot(token)

// /myid і /start доступні без auth — щоб новий користувач міг дізнатись свій ID
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

bot.on("message:text", ctx =>
  ctx.reply(`Ваше питання:\n${ctx.message.text}\n\n_(RAG + Claude будуть тут)_`, {
    parse_mode: "Markdown",
  }),
)

bot.catch(err => {
  console.error("Помилка бота:", err)
})

bot.start()
console.log("Бот запущено (long polling)...")
