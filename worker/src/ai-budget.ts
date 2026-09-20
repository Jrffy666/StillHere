import { z } from 'zod';

export const MAX_CALLS = 50;
export const MAX_RESERVED_TOKENS = 500_000;
export const MAX_RESERVATION_TOKENS = 33_200;

const DAY_MS = 86_400_000;
const RETENTION_MS = 7 * DAY_MS;
const PRUNE_RESERVATIONS = 400;
const PRUNE_DAYS = 32;
const reservationSchema = z.object({
  id: z.uuid(),
  reservedTokens: z.number().int().positive().max(MAX_RESERVATION_TOKENS),
}).strict();

export interface AiBudgetReservation {
  allowed: boolean;
  reason: 'reserved' | 'already_reserved' | 'daily_limit' | 'invalid_reservation';
  reservedTokens: number;
  day: string;
}

/**
 * The single governance object owns this global, conservative UTC-day budget.
 * A successful reservation is the only permission to dispatch once. Replays
 * are denied, and failed/aborted calls never refund an uncertain provider bill.
 */
export class AiBudgetLedger {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS ai_budget_day (day TEXT PRIMARY KEY, calls INTEGER NOT NULL CHECK(calls >= 0), reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens >= 0))');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS ai_budget_reservations (id TEXT PRIMARY KEY, day TEXT NOT NULL, reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens > 0), created_at INTEGER NOT NULL)');
    storage.sql.exec('CREATE INDEX IF NOT EXISTS ai_budget_reservations_created ON ai_budget_reservations(created_at)');
  }

  reserve(id: unknown, reservedTokens: unknown): AiBudgetReservation {
    const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
    const parsed = reservationSchema.safeParse({ id, reservedTokens });
    if (!parsed.success) return { allowed: false, reason: 'invalid_reservation', reservedTokens: 0, day };
    const requestId = parsed.data.id.toLowerCase(), amount = parsed.data.reservedTokens;

    return this.storage.transactionSync<AiBudgetReservation>(() => {
      // Bounded cleanup also handles a governance object waking after a long idle.
      // Reservation replay protection covers the retained seven-day window.
      const cutoff = now - RETENTION_MS, cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
      this.storage.sql.exec('DELETE FROM ai_budget_reservations WHERE id IN (SELECT id FROM ai_budget_reservations WHERE created_at < ? ORDER BY created_at, id LIMIT ?)', cutoff, PRUNE_RESERVATIONS);
      this.storage.sql.exec('DELETE FROM ai_budget_day WHERE day IN (SELECT day FROM ai_budget_day WHERE day < ? ORDER BY day LIMIT ?)', cutoffDay, PRUNE_DAYS);

      const existing = this.storage.sql.exec<{ day: string; reserved_tokens: number }>(
        'SELECT day, reserved_tokens FROM ai_budget_reservations WHERE id = ?', requestId,
      ).toArray()[0];
      if (existing) return existing.reserved_tokens === amount
        ? { allowed: false, reason: 'already_reserved', reservedTokens: existing.reserved_tokens, day: existing.day }
        : { allowed: false, reason: 'invalid_reservation', reservedTokens: 0, day };

      const budget = this.storage.sql.exec<{ calls: number; reserved_tokens: number }>(
        'SELECT calls, reserved_tokens FROM ai_budget_day WHERE day = ?', day,
      ).toArray()[0];
      if ((budget?.calls ?? 0) >= MAX_CALLS || (budget?.reserved_tokens ?? 0) + amount > MAX_RESERVED_TOKENS) {
        return { allowed: false, reason: 'daily_limit', reservedTokens: 0, day };
      }

      this.storage.sql.exec('INSERT INTO ai_budget_day (day, calls, reserved_tokens) VALUES (?, 1, ?) ON CONFLICT(day) DO UPDATE SET calls = calls + 1, reserved_tokens = reserved_tokens + excluded.reserved_tokens', day, amount);
      this.storage.sql.exec('INSERT INTO ai_budget_reservations (id, day, reserved_tokens, created_at) VALUES (?, ?, ?, ?)', requestId, day, amount, now);
      return { allowed: true, reason: 'reserved', reservedTokens: amount, day };
    });
  }
}
