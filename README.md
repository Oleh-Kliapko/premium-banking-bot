# 🏦 Premium Banking Bot

Закритий Telegram-бот — **AI-консультант по продуктах банку** (тарифи, картки, лаунжі, переваги преміум-пакетів). Прототип/демо для портфоліо.

> ⚠️ Демонстраційний прототип. Не є офіційним сервісом банку. Бренд Sense використано лише для внутрішнього демо.

---

## 🎯 Що вміє

- Відповідає на питання про продукти банку українською мовою
- Шукає відповіді у локальній базі знань (`help.sensebank.com.ua`) через RAG
- Якщо в базі немає — використовує веб-пошук по **білому списку офіційних доменів** (Visa, Mastercard, DragonPass, НБУ тощо)
- Цитує джерела під кожною відповіддю (клікабельні посилання)
- Не вигадує цифр/тарифів — чесно каже «перевірте в застосунку», якщо інформації немає
- Закритий доступ — відповідає лише користувачам з allowlist

---

## 🏗️ Архітектура

```
Повідомлення → [allowlist?] → ні → «бот приватний» (Claude не викликається)
                   │ так
                   ▼
   [ембединг питання] → [пошук у базі Sense] → топ-K чанків (поріг 0.55)
                   │
                   ├─ є збіг → Claude відповідає з бази (~$0.01)
                   └─ нема збігу → Claude + web_search по офіційних доменах (~$0.15)
                   │
                   ▼
        відповідь + джерела → Telegram
```

**Чому RAG, а не лише веб-пошук:** локальна база коштує ~$0.01 за запит проти ~$0.15 за веб-пошук з динамічною фільтрацією. Веб-пошук — лише fallback.

---

## 🧩 Стек

| Компонент | Технологія |
|---|---|
| Runtime | Node.js + TypeScript |
| Telegram | [grammY](https://grammy.dev) |
| LLM | Claude API (`claude-sonnet-4-6`) через `@anthropic-ai/sdk` |
| Ембединги | `intfloat/multilingual-e5-small` через `@huggingface/transformers` (локально) |
| Векторне сховище | JSON-файл + cosine similarity в пам'яті |
| Веб-пошук | Вбудований `web_search` Claude API з `allowed_domains` |
| Скрапер | `cheerio` + sitemap parsing + HEAD-check |
| Планувальник | `node-cron` (щодня о 5:00 Kyiv) |

---

## 📁 Структура

```
premium-banking-bot/
├── data/
│   ├── raw/                 # скраплені сторінки (.md) — gitignore
│   ├── index.json           # векторний індекс — gitignore
│   └── pages-meta.json      # метадані для HEAD-check — gitignore
├── scripts/
│   ├── scrape.ts            # sitemap → HEAD-check → scrape змінених сторінок
│   └── ingest.ts            # raw → чанки → ембединги → index.json
└── src/
    ├── bot.ts               # grammY: команди, обробники, cron
    ├── config/
    │   └── domains.ts       # ALLOWED_DOMAINS для веб-пошуку
    ├── middleware/
    │   ├── auth.ts          # allowlist по ALLOWED_USER_IDS
    │   └── rateLimit.ts     # per-user rate limit + ліміт довжини
    └── lib/
        ├── embedder.ts      # локальні мультимовні ембединги
        ├── retriever.ts     # cosine similarity + поріг
        └── claude.ts        # RAG + web_search fallback → відповідь + джерела
```

---

## ⚙️ Налаштування

### 1. Створити бота в Telegram

1. [@BotFather](https://t.me/BotFather) → `/newbot` → отримати токен
2. `/setprivacy` → Enable, `/setjoingroups` → Disable

### 2. Отримати Anthropic API ключ

[console.anthropic.com](https://console.anthropic.com) → API Keys → Create Key.
Постав ліміт витрат у Console (напр. $5).

### 3. Конфігурація

```bash
cp .env.example .env
```

`.env`:
```
TELEGRAM_BOT_TOKEN=         # від @BotFather
ALLOWED_USER_IDS=           # числові Telegram ID через кому: 123,456
ANTHROPIC_API_KEY=          # з console.anthropic.com
CLAUDE_MODEL=claude-sonnet-4-6
SIMILARITY_THRESHOLD=0.55   # поріг релевантності RAG
TOP_K=4                     # скільки чанків брати
WEB_SEARCH_MAX_USES=3
MAX_INPUT_CHARS=1000        # ліміт довжини питання
```

> Свій Telegram ID можна дізнатись командою `/myid` у боті.

---

## 🚀 Запуск

```bash
npm install

# 1. Зібрати базу знань (перший раз ~10-20 хв, ~1600 сторінок)
npm run scrape      # скрапить help.sensebank.com.ua
npm run ingest      # будує векторний індекс

# 2. Запустити бота
npm run dev         # long polling
```

База оновлюється автоматично **щодня о 5:00** (Kyiv) поки бот працює. Можна оновити вручну: `npm run scrape && npm run ingest`.

---

## 🤖 Команди бота

| Команда | Опис |
|---|---|
| `/start` | Привітання + дисклеймер |
| `/help` | Що вміє бот + приклади питань |
| `/myid` | Повертає твій Telegram ID (для allowlist) |
| текст | Питання → RAG + (за потреби) веб-пошук |

---

## 🛡️ Анти-галюцинаційні правила

1. Відповідає лише з бази банку або дозволених офіційних доменів
2. «Не знаю» — правильна відповідь, якщо інформації немає
3. Не називає цифр/тарифів, яких немає в джерелах
4. **Загальне ≠ персональне:** «Visa Signature дає лаунж» — загальне правило, тому додає «перевірте умови вашої картки в застосунку»
5. Завжди вказує джерело під відповіддю
6. Поріг релевантності 0.55 — відсіює слабко пов'язані чанки

---

## 💰 Контроль витрат

- Жорсткий cap у [Anthropic Console](https://console.anthropic.com)
- RAG (~$0.01) замість завжди-веб-пошуку (~$0.15)
- `max_uses: 1` на веб-пошук
- Не-allowlist користувач → нуль витрат (Claude не викликається)
- Per-user rate limit (10 запитів/хв) + ліміт довжини питання

---

## 🌐 Білий список доменів

Веб-пошук обмежений офіційними джерелами (`src/config/domains.ts`):
платіжні системи (Visa, Mastercard), лаунж-програми (DragonPass, LoungeKey, Priority Pass), регулятор (НБУ), офіційні сайти аеропортів. Жодних агрегаторів, форумів чи блогів.

---

## 📝 Ліцензія

ISC. Прототип для портфоліо.
