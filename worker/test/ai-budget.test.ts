import { env, evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetLedger } from '../src/ai-budget';
import { GOVERNANCE_NAME } from '../src/governance';

const DAY_MS = 86_400_000;
const governance = () => env.GOVERNANCE.getByName(GOVERNANCE_NAME);

beforeEach(async () => { await reset(); });
afterEach(() => { vi.restoreAllMocks(); });

async function reserve(id: unknown, tokens: unknown, at?: number) {
  return runInDurableObject(governance(), (_instance, state) => {
    const clock = at === undefined ? null : vi.spyOn(Date, 'now').mockReturnValue(at);
    try { return new AiBudgetLedger(state.storage).reserve(id, tokens); }
    finally { clock?.mockRestore(); }
  });
}
async function snapshot() {
  return runInDurableObject(governance(), (_instance, state) => ({
    days: state.storage.sql.exec<{ day: string; calls: number; reserved_tokens: number }>('SELECT day, calls, reserved_tokens FROM ai_budget_day ORDER BY day').toArray(),
    reservations: state.storage.sql.exec<{ id: string; day: string; reserved_tokens: number; created_at: number }>('SELECT id, day, reserved_tokens, created_at FROM ai_budget_reservations ORDER BY id').toArray(),
  }));
}

describe('Global conservative AI budget reservations', () => {
  it('persists a reservation before returning dispatch permission and denies duplicate dispatch after eviction', async () => {
    const id = crypto.randomUUID(), at = Date.UTC(2026, 8, 20, 12);
    expect(await reserve(id, 33_200, at)).toEqual({ allowed: true, reason: 'reserved', reservedTokens: 33_200, day: '2026-09-20' });
    const stored = await snapshot();
    expect(stored.days).toEqual([{ day: '2026-09-20', calls: 1, reserved_tokens: 33_200 }]);
    expect(stored.reservations).toEqual([{ id, day: '2026-09-20', reserved_tokens: 33_200, created_at: at }]);
    await evictDurableObject(governance());
    expect(await reserve(id, 33_200, at + 1000)).toEqual({ allowed: false, reason: 'already_reserved', reservedTokens: 33_200, day: '2026-09-20' });
    expect(await reserve(id.toUpperCase(), 33_200, at + 2000)).toMatchObject({ allowed: false, reason: 'already_reserved' });
    expect(await snapshot()).toEqual(stored);
  });

  it('rejects changed amounts for a reserved UUID without charging or replacing it', async () => {
    const id = crypto.randomUUID();
    await reserve(id, 1000);
    const stored = await snapshot();
    expect(await reserve(id, 999)).toMatchObject({ allowed: false, reason: 'invalid_reservation', reservedTokens: 0 });
    expect(await reserve(id, 1001)).toMatchObject({ allowed: false, reason: 'invalid_reservation', reservedTokens: 0 });
    expect(await snapshot()).toEqual(stored);
  });

  it('rejects malformed UUIDs and non-integer or oversized amounts before making any reservation', async () => {
    const id = crypto.randomUUID();
    const invalid: Array<[unknown, unknown]> = [
      ['', 1], ['not-a-uuid', 1], [` ${id}`, 1], [null, 1], [{ id }, 1],
      [id, 0], [id, -1], [id, 0.5], [id, 33_201], [id, Number.MAX_SAFE_INTEGER],
      [id, Number.NaN], [id, Number.POSITIVE_INFINITY], [id, '1000'], [id, null], [id, undefined],
    ];
    for (const [requestId, amount] of invalid) {
      expect(await reserve(requestId, amount)).toMatchObject({ allowed: false, reason: 'invalid_reservation', reservedTokens: 0 });
    }
    expect(await snapshot()).toEqual({ days: [], reservations: [] });
  });

  it('shares the 50-call cap across concurrent callers and does not refund abandoned or failed work', async () => {
    const ids = Array.from({ length: 60 }, () => crypto.randomUUID());
    // Every caller uses the same governance object; no caller identity can open a separate quota.
    const results = await Promise.all(ids.map(id => reserve(id, 1)));
    expect(results.filter(result => result.allowed)).toHaveLength(50);
    expect(results.filter(result => result.reason === 'daily_limit')).toHaveLength(10);
    const stored = await snapshot();
    expect(stored.days[0]).toMatchObject({ calls: 50, reserved_tokens: 50 });
    expect(stored.reservations).toHaveLength(50);
    // No completion/settlement is reported: even an interrupted caller keeps its reservation charged.
    await evictDurableObject(governance());
    expect(await reserve(crypto.randomUUID(), 1)).toMatchObject({ allowed: false, reason: 'daily_limit', reservedTokens: 0 });
    const chargedId = stored.reservations[0].id;
    expect(await reserve(chargedId, 1)).toMatchObject({ allowed: false, reason: 'already_reserved' });
    expect(await snapshot()).toEqual(stored);
  });

  it('allows exactly 500000 reserved tokens and rejects the next token without consuming a call', async () => {
    for (let index = 0; index < 15; index++) expect((await reserve(crypto.randomUUID(), 33_200)).allowed).toBe(true);
    expect((await reserve(crypto.randomUUID(), 2000)).allowed).toBe(true);
    const stored = await snapshot();
    expect(stored.days[0]).toMatchObject({ calls: 16, reserved_tokens: 500_000 });
    await evictDurableObject(governance());
    expect(await reserve(crypto.randomUUID(), 1)).toMatchObject({ allowed: false, reason: 'daily_limit', reservedTokens: 0 });
    expect(await snapshot()).toEqual(stored);
  });

  it('opens a fresh UTC-day quota while retaining prior-day deduplication and debits', async () => {
    const beforeMidnight = Date.UTC(2026, 8, 20, 23, 59, 59, 999), midnight = beforeMidnight + 1;
    const ids = Array.from({ length: 50 }, () => crypto.randomUUID());
    for (const id of ids) expect((await reserve(id, 1, beforeMidnight)).allowed).toBe(true);
    expect(await reserve(crypto.randomUUID(), 1, beforeMidnight)).toMatchObject({ allowed: false, reason: 'daily_limit', day: '2026-09-20' });
    await evictDurableObject(governance());
    expect(await reserve(ids[0], 1, midnight)).toEqual({ allowed: false, reason: 'already_reserved', reservedTokens: 1, day: '2026-09-20' });
    expect(await reserve(crypto.randomUUID(), 33_200, midnight)).toEqual({ allowed: true, reason: 'reserved', reservedTokens: 33_200, day: '2026-09-21' });
    expect((await snapshot()).days).toEqual([
      { day: '2026-09-20', calls: 50, reserved_tokens: 50 },
      { day: '2026-09-21', calls: 1, reserved_tokens: 33_200 },
    ]);
  });

  it('rolls back the day debit when storing the reservation fails', async () => {
    const result = await runInDurableObject(governance(), (_instance, state) => {
      const ledger = new AiBudgetLedger(state.storage);
      state.storage.sql.exec("CREATE TRIGGER reject_ai_reservation BEFORE INSERT ON ai_budget_reservations BEGIN SELECT RAISE(ABORT, 'Synthetic reservation write failure'); END");
      try { expect(() => ledger.reserve(crypto.randomUUID(), 1000)).toThrow(/Synthetic reservation write failure/); }
      finally { state.storage.sql.exec('DROP TRIGGER reject_ai_reservation'); }
      return {
        calls: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM ai_budget_day').one().count,
        reservations: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM ai_budget_reservations').one().count,
      };
    });
    expect(result).toEqual({ calls: 0, reservations: 0 });
    expect((await reserve(crypto.randomUUID(), 1000)).allowed).toBe(true);
  });

  it('prunes expired rows in bounded batches while keeping the seven-day boundary and current debits', async () => {
    const at = Date.UTC(2026, 8, 20, 12), cutoff = at - 7 * DAY_MS;
    const boundaryId = crypto.randomUUID(), currentId = crypto.randomUUID();
    await reserve(currentId, 1000, at);
    await runInDurableObject(governance(), (_instance, state) => {
      state.storage.transactionSync(() => {
        // Oversized synthetic history verifies one reservation does only bounded cleanup work.
        for (let index = 0; index < 405; index++) {
          state.storage.sql.exec('INSERT INTO ai_budget_reservations (id, day, reserved_tokens, created_at) VALUES (?, ?, ?, ?)', crypto.randomUUID(), '2026-09-12', 1, cutoff - 1);
        }
        state.storage.sql.exec('INSERT INTO ai_budget_reservations (id, day, reserved_tokens, created_at) VALUES (?, ?, ?, ?)', boundaryId, '2026-09-13', 1, cutoff);
        state.storage.sql.exec('INSERT INTO ai_budget_day (day, calls, reserved_tokens) VALUES (?, ?, ?)', '2026-09-12', 50, 50);
        state.storage.sql.exec('INSERT INTO ai_budget_day (day, calls, reserved_tokens) VALUES (?, ?, ?)', '2026-09-13', 1, 1);
      });
    });
    await reserve(crypto.randomUUID(), 1000, at);
    const first = await snapshot();
    expect(first.reservations.filter(row => row.created_at < cutoff)).toHaveLength(5);
    expect(first.reservations.some(row => row.id === boundaryId)).toBe(true);
    expect(first.days.some(row => row.day === '2026-09-12')).toBe(false);
    expect(first.days.find(row => row.day === '2026-09-20')).toMatchObject({ calls: 2, reserved_tokens: 2000 });
    await reserve(crypto.randomUUID(), 1000, at);
    const second = await snapshot();
    expect(second.reservations.filter(row => row.created_at < cutoff)).toHaveLength(0);
    expect(second.reservations.some(row => row.id === boundaryId)).toBe(true);
    expect(second.reservations.some(row => row.id === currentId)).toBe(true);
    expect(second.days.find(row => row.day === '2026-09-20')).toMatchObject({ calls: 3, reserved_tokens: 3000 });
  });
});
