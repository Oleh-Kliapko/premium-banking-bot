# TODO — premium-banking-bot

## Епік 1: Скафолд та бот-каркас
- [x] Ініціалізація проєкту (package.json, tsconfig, структура папок)
- [x] Залежності: grammY, @anthropic-ai/sdk, dotenv, tsx
- [x] `.env.example` + `.gitignore`
- [x] `src/bot.ts` — команди `/start`, `/help`, `/myid`, ехо
- [x] Запуск `npm run dev` (long polling працює)

## Епік 2: Контроль доступу
- [x] `src/middleware/auth.ts` — allowlist по ALLOWED_USER_IDS
- [x] `src/middleware/rateLimit.ts` — per-user rate limit + ліміт довжини
- [ ] Перевірка: чужий ID → «бот приватний», Claude не викликається

## Епік 3: Ембединги та локальна база
- [ ] `src/lib/embedder.ts` — мультимовна модель (@huggingface/transformers)
- [ ] `scripts/ingest.ts` — читання raw → чанки → ембединги → index.json
- [ ] `npm run ingest` — тестова індексація 3–5 сторінок
- [ ] `src/lib/retriever.ts` — cosine similarity, топ-K, поріг 0.4

## Епік 4: Claude + RAG
- [ ] `src/lib/claude.ts` — виклик Claude API (без веб-пошуку)
- [ ] `src/lib/rag.ts` — склейка контексту + системний промпт
- [ ] Відповідь з бази + джерела у Telegram
- [ ] Перевірка анти-галюцинаційних правил

## Епік 5: Веб-пошук
- [ ] `src/config/domains.ts` — ALLOWED_DOMAINS (білий список)
- [ ] Додати tool `web_search` у виклик Claude API (allowed_domains + max_uses)
- [ ] Логування web_search_requests + токенів
- [ ] Перевірка: питання поза базою → відповідь з офіційного домену + посилання
- [ ] Перевірка: «загальне ≠ персональне» → додається «перевірте в застосунку»

## Епік 6: Інтеграція та полірування
- [ ] Індикатор «друкує…» під час обробки
- [ ] Фінальна інтеграція всіх модулів у `bot.ts`
- [ ] Перевірка всіх критеріїв DoD (CLAUDE.md §14)
- [ ] README.md

## Критерії готовності (DoD)
- [ ] `/start`, `/help`, `/myid` працюють
- [ ] Не-allowlist → «бот приватний», Claude не викликається
- [ ] `npm run ingest` будує `index.json`
- [ ] Питання з бази → відповідь + джерело
- [ ] Питання поза базою → відповідь з офіційного домену + посилання
- [ ] Веб-пошук не виходить за межі allowed_domains
- [ ] «Загальне vs персональне» → «перевірте в застосунку»
- [ ] Нема інфо ніде → «не знаю»
- [ ] Немає цифр/умов поза джерелами
- [ ] Логуються токени і web_search_requests
