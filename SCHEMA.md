# 🗺️ SCHEMA — як усе влаштовано та що оновлювати руками

Повна карта системи `premium-banking-bot`: потік даних, зовнішні сервіси з посиланнями
та покрокові інструкції ручного обслуговування.

---

## 1. Зовнішні сервіси (де що лежить)

| Сервіс | Навіщо | Де керувати | Що зберігаємо |
|---|---|---|---|
| **Telegram / BotFather** | сам бот, токен | [@BotFather](https://t.me/BotFather) | `TELEGRAM_BOT_TOKEN` |
| **Anthropic (Claude)** | генерація відповіді + rewrite | [console.anthropic.com](https://console.anthropic.com) | `ANTHROPIC_API_KEY`, бюджет-кап |
| **Voyage AI** | ембединги (RAG) | [dashboard.voyageai.com](https://dashboard.voyageai.com) | `VOYAGE_API_KEY` |
| **Upstash Redis** | памʼять авторизованих | [console.upstash.com](https://console.upstash.com) | `REDIS_URL` |
| **GitHub** | код + хостинг `index.json` (Release) | [репо](https://github.com/Oleh-Kliapko/premium-banking-bot) · [releases](https://github.com/Oleh-Kliapko/premium-banking-bot/releases) | код, asset `index.json` |
| **Render** | хостинг бота 24/7 | [dashboard.render.com](https://dashboard.render.com) | усі env-змінні |
| **cron-job.org** | keep-alive пінгер | [console.cron-job.org](https://console.cron-job.org) | пінг `GET /` 10 хв |
| help.sensebank.com.ua | джерело бази знань | — | сирі сторінки (scrape) |

---

## 2. Топологія деплою

```
                        ┌─────────────────────────┐
   GitHub repo (public) │  push у main             │
   ──────────────────►  │  → Render auto-deploy     │
                        └───────────┬──────────────┘
                                    │ build: npm install && npm run build
                                    │ start: npm start
                                    ▼
   GitHub Release ───(INDEX_URL)──► ┌──────────────────────────────┐
   data-v1/index.json  завантаж.   │   RENDER Web Service (Free)    │
   (88 МБ)             на старті    │   ────────────────────────    │
                                    │   • health-сервер на PORT     │◄── cron-job.org
   Upstash Redis ──(REDIS_URL)────► │   • long-polling Telegram      │    GET / кожні 10 хв
   авторизовані ID                  │   • RAG у пам'яті (index.json) │    (щоб не засинав)
                                    └────────┬──────────┬───────────┘
                          Voyage API ◄───────┘          └──────► Anthropic API
                          (ембединг запиту)                      (відповідь + rewrite)
```

⚠️ Репо **мусить бути public** — інакше Render без авторизації не скачає asset з Release (404).

---

## 3. Потік одного повідомлення (runtime)

```
Користувач пише боту
   │
   ▼
[auth.ts] авторизований?  ──ні──► текст = логін?
   │ так                              ├─ так → запис у Redis (sessions.ts) → «Доступ надано»
   │                                  └─ ні  → «введіть логін»  (Claude НЕ викликається)
   ▼
[rateLimit.ts] 10/хв, довжина ≤ MAX_INPUT_CHARS
   │
   ▼
[bot.ts] перше питання? → одразу.  Інакше → кнопки «нове / продовження теми»
   │
   ▼
[claude.ts askClaude]
   ├─ rewrite питання (Haiku)                    ← збагачує синонімами, тримає тему фоллоу-апу
   ├─ embed(baseQuery, rewritten, голе)  → Voyage ← ембединг питання (512d), кілька запитів
   ├─ retrieveMulti (retriever.ts)               ← cosine по index.json, поріг 0.45,
   │      → топ-14 чанків, ≤2 на статтю, ФОП/ЮО відсіяні
   │
   ├─ ПРОХІД 1: Claude (Haiku) з document-блоками + citations:enabled
   │      └─ відповів → джерела = ТІЛЬКИ процитовані документи
   └─ ПРОХІД 2 (лише якщо прохід 1 сказав «не знайшов у документах»,
          або чанків не було, і WEB_SEARCH_MAX_USES>0):
          Claude + web_search (allowed_domains, max_uses 1) → джерела з вебу
   ▼
[bot.ts] прибираємо вже показані в цій темі (conversation.ts) → надсилаємо відповідь
```

Логи в терміналі/Render: `[Rewrite]`, `[Index]`, `[RAG] знайдено N чанків`, `[Claude] прохід=база/веб …`, `[Claude] разом in/out | джерело=база|веб | sources` (по `разом` видно повну вартість питання, `web=1` — коли був платний пошук).

---

## 4. Як будується база знань (offline, локально)

```
help.sensebank.com.ua/sitemap.xml
   │  npm run scrape  (scripts/scrape.ts)
   │  • sitemap → список URL
   │  • HEAD-check Last-Modified → качаємо лише нові/змінені
   ▼
data/raw/*.md   (+ data/curated/*.md — ручні документи)
   │  npm run ingest  (scripts/ingest.ts)
   │  • чистка boilerplate → чанки ~600 симв.
   │  • пропуск ФОП/ЮО + дедуп дублікатів чанків (сайт під кількома URL ≈ 64% дублів)
   │  • Voyage embed (батчі по 128)  ← потрібен VOYAGE_API_KEY
   ▼
data/index.json  (~34 МБ, ~4.4k чанків, 512-вимірні вектори)
```

---

## 5. 🔧 Ручне обслуговування — ЩО, КОЛИ, ЯК

### 5.1. Оновити базу знань (повний цикл)
**Коли:** змінились/зʼявились статті на сайті банку; хочеш свіжу базу.
**Як (локально):**
```bash
npm run scrape          # підтягне лише нові/змінені сторінки
npm run ingest          # перебудує index.json через Voyage
```
Потім **залити новий `data/index.json`** у GitHub Release:
1. [Edit release data-v1](https://github.com/Oleh-Kliapko/premium-banking-bot/releases/edit/data-v1)
2. Видали старий asset `index.json` (×) → перетягни новий → **Update release**
   (URL лишається тим самим, `INDEX_URL` міняти не треба)
3. Render → **Manual Deploy → Restart** (бот скачає новий індекс)

> ⚠️ Для повного `ingest` (~2.5М токенів) тимчасово додай у Voyage спосіб оплати —
> підніме rate-limit, реіндекс пройде за хвилини (лишається в межах free, ~$0.06).
> Після — можеш прибрати картку.

### 5.2. Швидко правнути «ручний» документ (контакти тощо)
**Коли:** треба змінити лише `data/curated/*.md` (не чіпаючи скрап).
**Як:**
```bash
# відредагуй data/curated/<файл>.md
npm run ingest:curated  # ~30с, переіндексує лише curated-чанки
```
Далі — той самий re-upload у Release + Restart (п. 5.1, кроки 1–3).

### 5.3. Додати людину (новий логін)
**Коли:** треба дати комусь доступ.
**Як:** додай логін у `ALLOWED_LOGINS` (через кому) **у двох місцях**:
- локальний `.env`
- Render → Environment → `ALLOWED_LOGINS` → Save (Render передеплоїть)

Потім просто дай людині цей логін — вона введе його боту й зайде.
(Telegram ID питати **не треба**.)

### 5.4. Додати офіційний домен для веб-пошуку
**Коли:** хочеш дозволити нове офіційне джерело (напр. сайт аеропорту).
**Як:** додай домен у `src/config/domains.ts` → `git push` → Render задеплоїть сам.

### 5.5. Змінити модель / поріг / TOP_K
**Як:** зміни відповідну env (`CLAUDE_MODEL`, `SIMILARITY_THRESHOLD`, `TOP_K`,
`CHUNKS_PER_ARTICLE`) на Render (і в `.env` локально). Render передеплоїть.

### 5.6. Ротація ключів
**Як:** онови ключ у Render Environment **і** в локальному `.env`. Жодних змін у коді.

---

## 6. Env-змінні: де що ставити

| Змінна | Локально (`.env`) | Render | Призначення |
|---|:---:|:---:|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | ✅ | токен бота |
| `ALLOWED_LOGINS` | ✅ | ✅ | дозволені логіни |
| `ANTHROPIC_API_KEY` | ✅ | ✅ | Claude |
| `VOYAGE_API_KEY` | ✅ | ✅ | ембединги |
| `CLAUDE_MODEL` | ✅ | ✅ | `claude-haiku-4-5` |
| `SIMILARITY_THRESHOLD` | ✅ | ✅ | `0.45` |
| `TOP_K` / `CHUNKS_PER_ARTICLE` | ✅ | ✅ | `14` / `2` |
| `WEB_SEARCH_MAX_USES` | ✅ | ✅ | `1` (0 = вимкнути веб) |
| `MAX_INPUT_CHARS` | ✅ | ✅ | `1000` |
| `REDIS_URL` | — (файл) | ✅ | памʼять входу |
| `INDEX_URL` | — (локальний файл) | ✅ | звідки качати індекс |
| `DISABLE_CRON` | — | ✅ `1` | вимкнути крон на сервері |
| `PORT` | — | авто | Render задає сам |

> На сервері `.env` **не використовується** — усе через Render → Environment.
> `.env`, `data/index.json`, `data/sessions.json`, `data/raw/` — у `.gitignore`.

---

## 7. Типові проблеми

| Симптом | Причина | Рішення |
|---|---|---|
| `Ran out of memory` | локальна модель ембедингів / завеликий індекс | має бути Voyage (не transformers); індекс 512d |
| `INDEX_URL відповів 404` | репо приватне або asset не той | репо public; перевір тег/назву asset у Release |
| `VOYAGE_API_KEY не встановлено` | ключ не доданий на Render | Render → Environment → додати ключ |
| `409 Conflict` під час деплою | перекриття старого/нового інстансів (zero-downtime Render) | оброблено: `startPolling` ретраїть 12×5с, поки старий звільнить лок — краш не настає. Якщо 409 **постійний** — не запускай локально, поки живий Render (один токен) |
| Бот «спить», відповідає з затримкою | немає keep-alive | cron-job.org пінг `GET /` кожні 10 хв |
| Перелогін після рестарту на сервері | немає `REDIS_URL` | додати Upstash `REDIS_URL` на Render |

---

## 8. Команди (швидка пам'ятка)

```bash
npm run dev             # локальний запуск (long polling)
npm run scrape          # оновити data/raw/ зі сайту банку
npm run ingest          # повна побудова index.json (Voyage)
npm run ingest:curated  # швидка реіндексація лише data/curated/
npm run build           # tsc → dist/ (Render використовує це)
npm start               # node dist/src/bot.js (прод-запуск)
```
