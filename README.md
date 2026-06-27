# 🏦 Premium Banking Bot

Закритий Telegram-бот — **AI-консультант по продуктах банку** (тарифи, картки, лаунжі, переваги преміум-пакетів). Робочий прототип/демо для портфоліо, **задеплоєний 24/7 на безкоштовному хостингу**.

> ⚠️ Демонстраційний прототип. Не є офіційним сервісом банку. Бренд Sense використано лише для демо.

---

## 🎯 Що вміє

- Відповідає українською на питання про продукти банку
- Шукає відповіді у локальній базі знань (`help.sensebank.com.ua`) через **RAG**
- Якщо в базі немає — **веб-пошук по білому списку офіційних доменів** (Visa, Mastercard, DragonPass, НБУ) як fallback
- Цитує **лише ті джерела, які реально використав** (нативні citations Claude) — клікабельні посилання
- Не вигадує цифр/тарифів — чесно каже «перевірте в застосунку», якщо інформації немає
- Памʼятає контекст діалогу; у межах теми **не дублює вже показані джерела**
- Закритий доступ за **логіном-перепусткою** (самостійне підключення без участі адміна)

---

## 🏗️ Архітектура

```
Повідомлення → [авторизований?] → ні → запит логіну (ALLOWED_LOGINS)
                   │ так                     │ вірний → запам'ятати (Redis)
                   ▼
   [rate limit] → [rewrite питання (Haiku)] → [ембединг (Voyage API)]
                   │
                   ▼
   [пошук у базі Sense] → топ-K чанків (cosine, поріг 0.45, ФОП/ЮО відсіяні)
                   │
                   ├─ є збіг → Claude (Sonnet) відповідає з бази + citations
                   └─ нема   → Claude + web_search по офіційних доменах (fallback)
                   │
                   ▼
        відповідь + тільки процитовані джерела → Telegram
```

> Детальна схема процесу, зовнішні сервіси та інструкції ручного оновлення — у [SCHEMA.md](SCHEMA.md).

**Ключові рішення:**
- **Ембединги через хмарний API (Voyage), а не локальну модель** — локальна `transformers.js` їла ~1.6 ГБ RAM і не влазила у безкоштовний хостинг (512 МБ). Voyage прибирає модель з процесу.
- **RAG замість завжди-веб-пошуку** — локальна база ~$0.01/запит проти ~$0.15 за веб-пошук з динамічною фільтрацією. Веб-пошук — лише fallback.
- **Нативні citations** — у джерела потрапляє тільки те, що Claude реально цитував (а не весь топ-K).

---

## 🧩 Стек

| Компонент | Технологія |
|---|---|
| Runtime | Node.js + TypeScript |
| Telegram | [grammY](https://grammy.dev) |
| LLM | Claude API (`claude-sonnet-4-6`) + Haiku для rewrite, через `@anthropic-ai/sdk` |
| Ембединги | **[Voyage AI](https://voyageai.com)** `voyage-3.5-lite` (512 вимірів), мультимовні |
| Векторне сховище | JSON-файл (88 МБ) + cosine similarity в пам'яті |
| Памʼять входу | **[Upstash Redis](https://upstash.com)** (або локальний файл) |
| Веб-пошук | Вбудований `web_search` Claude API з `allowed_domains` (fallback) |
| Скрапер | `cheerio` + sitemap parsing + HEAD-check |
| Хостинг | **[Render](https://render.com)** Free + keep-alive пінгер |

---

## 📁 Структура

```
premium-banking-bot/
├── data/
│   ├── curated/             # ручні документи (контакти тощо) — у git
│   ├── raw/                 # скраплені сторінки (.md) — gitignore
│   └── index.json           # векторний індекс 88 МБ — gitignore (GitHub Release)
├── scripts/
│   ├── scrape.ts            # sitemap → HEAD-check → scrape змінених сторінок
│   ├── ingest.ts            # raw+curated → чанки → Voyage ембединги → index.json
│   └── ingest-curated.ts    # швидка реіндексація лише curated-документів
└── src/
    ├── bot.ts               # grammY: команди, кнопки, cron, bootstrap
    ├── config/
    │   └── domains.ts       # ALLOWED_DOMAINS для веб-пошуку
    ├── middleware/
    │   ├── auth.ts          # гейт за логіном (ALLOWED_LOGINS)
    │   └── rateLimit.ts     # per-user rate limit + ліміт довжини
    └── lib/
        ├── embedder.ts      # ембединги через Voyage API
        ├── retriever.ts     # cosine + поріг + ФОП/ЮО фільтр + дедуп статей
        ├── claude.ts        # RAG + citations + web_search fallback + rewrite
        ├── conversation.ts  # памʼять діалогу + дедуп показаних джерел
        ├── sessions.ts      # доступ за логіном + персистентність Redis/файл
        └── bootstrap.ts     # health-сервер (keep-alive) + завантаження індексу
```

---

## ⚙️ Налаштування

### 1. Telegram-бот
[@BotFather](https://t.me/BotFather) → `/newbot` → токен. `/setprivacy` → Enable, `/setjoingroups` → Disable.

### 2. Ключі
- **Anthropic:** [console.anthropic.com](https://console.anthropic.com) → API Keys. Постав ліміт витрат (напр. $5).
- **Voyage:** [dashboard.voyageai.com](https://dashboard.voyageai.com) → API Keys (free-тариф покриває з запасом).
- **Redis (для деплою):** [console.upstash.com](https://console.upstash.com) → Create Database → скопіюй `rediss://...` URL.

### 3. Конфігурація

```bash
cp .env.example .env
```

```
TELEGRAM_BOT_TOKEN=         # від @BotFather
ALLOWED_LOGINS=             # логіни-перепустки через кому: guest2026,demo-sense
ANTHROPIC_API_KEY=          # console.anthropic.com
VOYAGE_API_KEY=             # dashboard.voyageai.com
CLAUDE_MODEL=claude-sonnet-4-6
SIMILARITY_THRESHOLD=0.45   # поріг релевантності RAG (під Voyage)
TOP_K=14                    # скільки чанків (різних статей) подавати Claude
CHUNKS_PER_ARTICLE=1        # макс. чанків з однієї статті
WEB_SEARCH_MAX_USES=3
MAX_INPUT_CHARS=1000

# опційно (для сервера):
REDIS_URL=                  # Upstash; без нього — локальний файл sessions.json
INDEX_URL=                  # URL index.json у GitHub Release; качається на старті
DISABLE_CRON=               # на сервері = 1 (вимикає важкий scrape+ingest)
```

---

## 🚀 Запуск (локально)

```bash
npm install

# 1. Зібрати базу знань (перший раз ~10-20 хв)
npm run scrape      # скрапить help.sensebank.com.ua у data/raw/
npm run ingest      # будує index.json через Voyage (~88 МБ)

# 2. Запустити бота
npm run dev         # long polling
```

> Як оновлювати базу, заливати індекс і деплоїти — покроково в [SCHEMA.md](SCHEMA.md).

---

## 🌐 Деплой (Render Free, 24/7, $0)

Коротко (повна інструкція — у [SCHEMA.md](SCHEMA.md)):

1. `index.json` лежить як asset **GitHub Release** (репо публічне) → бот качає на старті через `INDEX_URL`.
2. Render **Web Service** (Free): Build `npm install && npm run build`, Start `npm start`.
3. Env: усі ключі + `REDIS_URL`, `INDEX_URL`, `DISABLE_CRON=1`.
4. Keep-alive: [cron-job.org](https://cron-job.org) пінгує `GET /` кожні 10 хв (щоб Free-інстанс не засинав).

---

## 🤖 Команди

| Команда | Опис |
|---|---|
| `/start` | Привітання / запит логіну, якщо не авторизований |
| `/help` | Що вміє бот + приклади |
| `/reset` | Очистити контекст розмови |
| текст | Логін (якщо не авторизований) або питання |

---

## 🛡️ Анти-галюцинаційні правила

1. Відповідає лише з бази банку або дозволених офіційних доменів
2. «Не знаю» — правильна відповідь, якщо інформації немає (без нерелевантних джерел)
3. Не називає цифр/тарифів поза джерелами
4. **Загальне ≠ персональне:** «Visa Signature дає лаунж» — загальне правило → додає «перевірте умови вашої картки в застосунку»
5. Джерела — лише ті, що Claude **реально процитував** (нативні citations)
6. Поріг релевантності 0.45; ФОП/ЮО статті виключені (преміум-менеджер ними не консультує)

---

## 💰 Контроль витрат

- Жорсткий cap у [Anthropic Console](https://console.anthropic.com) (основна вартість ≈ $0.01/відповідь)
- Voyage — копійки: реіндекс ≈ $0.06 разово, запит ≈ частки цента (free-тариф покриває)
- RAG (~$0.01) замість веб-пошуку (~$0.15); `max_uses: 1`
- Неавторизований користувач → **нуль витрат** (Claude не викликається)
- Per-user rate limit (10/хв) + ліміт довжини питання

---

## 📝 Ліцензія

ISC. Прототип для портфоліо.
