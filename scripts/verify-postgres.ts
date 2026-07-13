import { cleanupExpiredChatState } from "../agent/lib/db/cleanup";
import { getBurnModeDatabase } from "../agent/lib/db/client";
import { recordBurnModeEvent } from "../agent/lib/db/events";
import { createBurnModeChatState } from "../agent/lib/chat-state";

async function main(): Promise<void> {
  process.env.VERCEL_PROJECT_ID = "verification";
  process.env.VERCEL_ENV = "development";

  const state = createBurnModeChatState();
  const keyPrefix = "burn-mode:sendblue:verification:development";
  const key = `verification:${Date.now()}`;
  const raceKey = `${key}:race`;
  const cleanupRaceKey = `${key}:cleanup-race`;
  const concurrentQueueKey = `${key}:concurrent-queue`;
  const listTtlKey = `${key}:list-ttl`;
  const { pool } = getBurnModeDatabase();

  try {
    await state.connect();

    await state.set(key, { ok: true }, 50);
    const cached = await state.get<{ ok: boolean }>(key);
    if (cached?.ok !== true) throw new Error("Cache round-trip failed.");

    await new Promise((resolve) => setTimeout(resolve, 75));
    const reclaimed = await state.setIfNotExists(
      key,
      { reclaimed: true },
      1_000,
    );
    if (!reclaimed) throw new Error("Expired cache reclaim failed.");

    const raceResults = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        state.setIfNotExists(raceKey, { index }, 1_000),
      ),
    );
    if (raceResults.filter(Boolean).length !== 1) {
      throw new Error("Atomic cache claim failed under contention.");
    }

    const lock = await state.acquireLock(key, 1_000);
    if (!lock || (await state.acquireLock(key, 1_000)) !== null) {
      throw new Error("Lock exclusion failed.");
    }
    if (!(await state.extendLock(lock, 1_000))) {
      throw new Error("Lock extension failed.");
    }
    await state.releaseLock(lock);

    await state.appendToList(key, 1, { maxLength: 2, ttlMs: 1_000 });
    await state.appendToList(key, 2, { maxLength: 2, ttlMs: 1_000 });
    await state.appendToList(key, 3, { maxLength: 2, ttlMs: 1_000 });
    const list = await state.getList<number>(key);
    if (JSON.stringify(list) !== "[2,3]") {
      throw new Error(`List trim failed: ${JSON.stringify(list)}`);
    }

    await state.appendToList(listTtlKey, 1, { ttlMs: 5_000 });
    await state.appendToList(listTtlKey, 2);
    const listTtl = await pool.query<{
      all_expiring: boolean;
      expiration_count: number;
      row_count: number;
    }>(
      `SELECT
         count(*)::int AS row_count,
         count(DISTINCT expires_at)::int AS expiration_count,
         bool_and(expires_at IS NOT NULL) AS all_expiring
       FROM chat_state_lists
       WHERE key_prefix = $1 AND list_key = $2`,
      [keyPrefix, listTtlKey],
    );
    const listTtlResult = listTtl.rows[0];
    if (
      listTtlResult?.row_count !== 2 ||
      listTtlResult.expiration_count !== 1 ||
      listTtlResult.all_expiring !== true
    ) {
      throw new Error("List key TTL was not preserved.");
    }

    const now = Date.now();
    await state.enqueue(
      key,
      {
        enqueuedAt: now,
        expiresAt: now + 1_000,
        message: {} as never,
      },
      2,
    );
    if ((await state.queueDepth(key)) !== 1 || !(await state.dequeue(key))) {
      throw new Error("Queue round-trip failed.");
    }

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        state.enqueue(
          concurrentQueueKey,
          {
            enqueuedAt: now + index,
            expiresAt: now + 5_000,
            message: { index } as never,
          },
          5,
        ),
      ),
    );
    if ((await state.queueDepth(concurrentQueueKey)) !== 5) {
      throw new Error("Atomic queue trimming failed under contention.");
    }

    await state.subscribe(key);
    if (!(await state.isSubscribed(key))) {
      throw new Error("Subscription persistence failed.");
    }
    await state.unsubscribe(key);
    if (await state.isSubscribed(key)) {
      throw new Error("Subscription removal failed.");
    }

    await recordBurnModeEvent({
      correlationKey: key,
      eventType: "system.verification",
      source: "test",
    });

    await state.set(cleanupRaceKey, { renewed: true }, -1_000);
    const renewalClient = await pool.connect();
    try {
      await renewalClient.query("BEGIN");
      await renewalClient.query(
        `SELECT 1 FROM chat_state_cache
         WHERE key_prefix = $1 AND cache_key = $2
         FOR UPDATE`,
        [keyPrefix, cleanupRaceKey],
      );
      const cleanup = cleanupExpiredChatState();
      await new Promise((resolve) => setTimeout(resolve, 75));
      await renewalClient.query(
        `UPDATE chat_state_cache
         SET expires_at = now() + interval '5 minutes'
         WHERE key_prefix = $1 AND cache_key = $2`,
        [keyPrefix, cleanupRaceKey],
      );
      await renewalClient.query("COMMIT");
      await cleanup;
    } catch (error) {
      await renewalClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      renewalClient.release();
    }
    const renewed = await state.get<{ renewed: boolean }>(cleanupRaceKey);
    if (renewed?.renewed !== true) {
      throw new Error("Cleanup deleted freshly renewed state.");
    }

    await cleanupExpiredChatState();

    console.log(
      "PlanetScale state, Drizzle events, locks, lists, queues, and TTL reclaim verified.",
    );
  } finally {
    await state.delete(key).catch(() => undefined);
    await state.delete(raceKey).catch(() => undefined);
    await state.delete(cleanupRaceKey).catch(() => undefined);
    await pool
      .query(
        "DELETE FROM chat_state_lists WHERE key_prefix = $1 AND list_key = $2",
        [keyPrefix, key],
      )
      .catch(() => undefined);
    await pool
      .query(
        "DELETE FROM chat_state_lists WHERE key_prefix = $1 AND list_key = $2",
        [keyPrefix, listTtlKey],
      )
      .catch(() => undefined);
    await pool
      .query(
        "DELETE FROM chat_state_locks WHERE key_prefix = $1 AND thread_id = $2",
        [keyPrefix, key],
      )
      .catch(() => undefined);
    await pool
      .query(
        "DELETE FROM chat_state_queues WHERE key_prefix = $1 AND thread_id = $2",
        [keyPrefix, key],
      )
      .catch(() => undefined);
    await pool
      .query(
        "DELETE FROM chat_state_queues WHERE key_prefix = $1 AND thread_id = $2",
        [keyPrefix, concurrentQueueKey],
      )
      .catch(() => undefined);
    await pool
      .query(
        "DELETE FROM chat_state_subscriptions WHERE key_prefix = $1 AND thread_id = $2",
        [keyPrefix, key],
      )
      .catch(() => undefined);
    await pool
      .query("DELETE FROM burn_mode_events WHERE correlation_key = $1", [key])
      .catch(() => undefined);
    await state.disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
