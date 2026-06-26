// Проста пам'ять розмови в пам'яті процесу (per-user)
export interface Turn {
	role: "user" | "assistant"
	content: string
}

const MAX_TURNS = 6 // ~3 обміни
const TTL_MS = 30 * 60 * 1000 // 30 хв неактивності → скидаємо

interface UserState {
	turns: Turn[]
	updatedAt: number
}

const store = new Map<number, UserState>()

export function getHistory(userId: number): Turn[] {
	const state = store.get(userId)
	if (!state) return []
	// Скидаємо застарілу розмову
	if (Date.now() - state.updatedAt > TTL_MS) {
		store.delete(userId)
		return []
	}
	return state.turns
}

export function addTurn(userId: number, role: Turn["role"], content: string) {
	const state = store.get(userId) ?? { turns: [], updatedAt: Date.now() }
	state.turns.push({ role, content })
	while (state.turns.length > MAX_TURNS) state.turns.shift()
	state.updatedAt = Date.now()
	store.set(userId, state)
}

export function clearHistory(userId: number) {
	store.delete(userId)
}

// Питання, що чекає на вибір "нове/продовження"
const pending = new Map<number, string>()

export function setPending(userId: number, question: string) {
	pending.set(userId, question)
}

export function takePending(userId: number): string | undefined {
	const q = pending.get(userId)
	pending.delete(userId)
	return q
}

// Текст останнього питання користувача — для збагачення RAG-запиту
export function lastUserQuestion(userId: number): string {
	const turns = getHistory(userId)
	for (let i = turns.length - 1; i >= 0; i--) {
		if (turns[i].role === "user") return turns[i].content
	}
	return ""
}
