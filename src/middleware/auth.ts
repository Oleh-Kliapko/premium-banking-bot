import { MiddlewareFn } from 'grammy';
import type { Context } from 'grammy';

const allowedIds = new Set(
  (process.env.ALLOWED_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map(Number)
);

export const authMiddleware: MiddlewareFn<Context> = (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || !allowedIds.has(userId)) {
    return ctx.reply('🔒 Цей бот приватний. Доступ за запрошенням.');
  }
  return next();
};
