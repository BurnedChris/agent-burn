import { sql } from "drizzle-orm";

import { getBurnModeDatabase } from "./client";

export interface CleanupResult {
  cache: number;
  lists: number;
  locks: number;
  queues: number;
}

const BATCH_SIZE = 1_000;

function deletedCount(result: { rows: Record<string, unknown>[] }): number {
  const value = result.rows[0]?.deleted;
  return typeof value === "number" ? value : Number(value ?? 0);
}

/** Delete bounded batches in separate transactions so cleanup stays polite. */
export async function cleanupExpiredChatState(): Promise<CleanupResult> {
  const { database } = getBurnModeDatabase();

  const locks = await database.execute(sql`
    WITH expired AS (
      SELECT key_prefix, thread_id
      FROM chat_state_locks
      WHERE expires_at <= now()
      LIMIT ${BATCH_SIZE}
    ), deleted AS (
      DELETE FROM chat_state_locks AS target
      USING expired
      WHERE target.key_prefix = expired.key_prefix
        AND target.thread_id = expired.thread_id
        AND target.expires_at <= now()
      RETURNING 1
    )
    SELECT count(*)::int AS deleted FROM deleted
  `);
  const cache = await database.execute(sql`
    WITH expired AS (
      SELECT key_prefix, cache_key
      FROM chat_state_cache
      WHERE expires_at <= now()
      LIMIT ${BATCH_SIZE}
    ), deleted AS (
      DELETE FROM chat_state_cache AS target
      USING expired
      WHERE target.key_prefix = expired.key_prefix
        AND target.cache_key = expired.cache_key
        AND target.expires_at <= now()
      RETURNING 1
    )
    SELECT count(*)::int AS deleted FROM deleted
  `);
  const lists = await database.execute(sql`
    WITH expired AS (
      SELECT key_prefix, list_key, seq
      FROM chat_state_lists
      WHERE expires_at <= now()
      LIMIT ${BATCH_SIZE}
    ), deleted AS (
      DELETE FROM chat_state_lists AS target
      USING expired
      WHERE target.key_prefix = expired.key_prefix
        AND target.list_key = expired.list_key
        AND target.seq = expired.seq
        AND target.expires_at <= now()
      RETURNING 1
    )
    SELECT count(*)::int AS deleted FROM deleted
  `);
  const queues = await database.execute(sql`
    WITH expired AS (
      SELECT key_prefix, thread_id, seq
      FROM chat_state_queues
      WHERE expires_at <= now()
      LIMIT ${BATCH_SIZE}
    ), deleted AS (
      DELETE FROM chat_state_queues AS target
      USING expired
      WHERE target.key_prefix = expired.key_prefix
        AND target.thread_id = expired.thread_id
        AND target.seq = expired.seq
        AND target.expires_at <= now()
      RETURNING 1
    )
    SELECT count(*)::int AS deleted FROM deleted
  `);

  return {
    cache: deletedCount(cache),
    lists: deletedCount(lists),
    locks: deletedCount(locks),
    queues: deletedCount(queues),
  };
}
