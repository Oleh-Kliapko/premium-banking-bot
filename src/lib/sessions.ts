// Доступ за логіном-перепусткою (замість allowlist по Telegram ID).
// Список валідних логінів — у env ALLOWED_LOGINS (через кому). Хто ввів
// валідний логін — запам'ятовується, і далі бот пускає без запитань.
//
// Персистентність авторизованих акаунтів — два бекенди:
//   • REDIS_URL заданий  → Redis (Upstash / Render Key Value): переживає
//     рестарт і деплой на сервері, росте в рантаймі. Для продакшену.
//   • REDIS_URL відсутній → файл data/sessions.json: зручно локально.
//
// Гарячий шлях (isAuthorized/tryLogin) — синхронний: тримаємо Set у пам'яті,
// а бекенд чіпаємо лише при старті (завантажити) і при логіні (дописати).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"

const FILE = join(process.cwd(), "data", "sessions.json")
const REDIS_KEY = "bot:authorized" // Redis SET з ID авторизованих акаунтів

function allowedLogins(): string[] {
	return (process.env.ALLOWED_LOGINS || "")
		.split(",")
		.map(s => s.trim())
		.filter(Boolean)
}

// Авторизовані Telegram-акаунти (робоча копія в пам'яті)
const authorized = new Set<number>()

// ---- Бекенд персистентності ----
interface Backend {
	loadAll(): Promise<number[]>
	add(id: number): Promise<void>
}

function fileBackend(): Backend {
	return {
		async loadAll() {
			try {
				if (existsSync(FILE))
					return JSON.parse(readFileSync(FILE, "utf-8")) as number[]
			} catch (e) {
				console.error("[Sessions] читання файлу:", e)
			}
			return []
		},
		async add() {
			// Для файлу найпростіше перезаписати повний список
			try {
				mkdirSync(dirname(FILE), { recursive: true })
				writeFileSync(FILE, JSON.stringify([...authorized]))
			} catch (e) {
				console.error("[Sessions] запис файлу:", e)
			}
		},
	}
}

function redisBackend(url: string): Backend {
	// Ліниве підключення — ioredis потрібен лише коли заданий REDIS_URL
	const Redis = require("ioredis")
	const client = new Redis(url)
	client.on("error", (e: unknown) =>
		console.error("[Sessions] Redis помилка:", e),
	)
	return {
		async loadAll() {
			const ids: string[] = await client.smembers(REDIS_KEY)
			return ids.map(Number).filter((n: number) => Number.isFinite(n))
		},
		async add(id: number) {
			await client.sadd(REDIS_KEY, String(id))
		},
	}
}

const useRedis = Boolean(process.env.REDIS_URL)
const backend: Backend = useRedis
	? redisBackend(process.env.REDIS_URL as string)
	: fileBackend()

// Завантажуємо існуючих авторизованих у пам'ять. Викликати один раз на старті.
export async function initSessions(): Promise<void> {
	const ids = await backend.loadAll()
	for (const id of ids) authorized.add(id)
	console.log(
		`[Sessions] завантажено ${authorized.size} авторизованих (${useRedis ? "Redis" : "файл"})`,
	)
}

export function isAuthorized(userId: number): boolean {
	return authorized.has(userId)
}

// Спроба входу: якщо текст збігається з одним із дозволених логінів —
// авторизуємо акаунт (у пам'яті) і фоново персистимо.
export function tryLogin(userId: number, text: string): boolean {
	const login = text.trim()
	if (!login || !allowedLogins().includes(login)) return false
	authorized.add(userId)
	// Не блокуємо відповідь користувачу — пишемо у фоні
	backend.add(userId).catch(e => console.error("[Sessions] persist:", e))
	console.log(`[Sessions] авторизовано ${userId} (всього: ${authorized.size})`)
	return true
}
