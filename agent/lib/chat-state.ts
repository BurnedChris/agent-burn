import { randomUUID } from "node:crypto";

import { createMemoryState } from "@chat-adapter/state-memory";
import type { Lock, QueueEntry, StateAdapter } from "chat";
import type { Pool, PoolClient } from "pg";

import { getBurnModeDatabase } from "./db/client";
import { deploymentNamespace } from "./deployment-namespace";

function serialize(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Postgres chat state cannot store undefined.");
  }
  return serialized;
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

/**
 * A migration-owned Postgres StateAdapter. Transactions and transaction-level
 * advisory locks preserve list and queue semantics through PlanetScale's
 * transaction-pooled PgBouncer endpoint without granting runtime DDL access.
 */
class BurnModePostgresState implements StateAdapter {
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly keyPrefix: string,
  ) {}

  async connect(): Promise<void> {
    if (this.connected) return;

    if (!this.connectPromise) {
      const connection = (async () => {
        // Migrations own the schema. Validate the exact least-privilege runtime
        // contract without attempting DDL or writing verification rows.
        const privileges = await this.pool.query<{ ready: boolean }>(
          `SELECT
             bool_and(
               has_table_privilege(
                 current_user,
                 table_name,
                 'SELECT,INSERT,UPDATE,DELETE'
               )
             )
             AND bool_and(
               has_sequence_privilege(
                 current_user,
                 sequence_name,
                 'USAGE,SELECT,UPDATE'
               )
             ) AS ready
           FROM unnest(ARRAY[
             'chat_state_subscriptions',
             'chat_state_locks',
             'chat_state_cache',
             'chat_state_lists',
             'chat_state_queues',
             'burn_mode_events'
           ]::text[]) AS tables(table_name)
           CROSS JOIN unnest(ARRAY[
             'chat_state_lists_seq_seq',
             'chat_state_queues_seq_seq',
             'burn_mode_events_id_seq'
           ]::text[]) AS sequences(sequence_name)`,
        );
        if (privileges.rows[0]?.ready !== true) {
          throw new Error(
            "DATABASE_URL must have read/write table and sequence privileges. Apply migrations with an admin role, then use a pg_read_all_data + pg_write_all_data application role.",
          );
        }
        this.connected = true;
      })().finally(() => {
        if (this.connectPromise === connection) this.connectPromise = null;
      });
      this.connectPromise = connection;
    }

    await this.connectPromise;
  }

  async disconnect(): Promise<void> {
    // The pool is shared with Drizzle and attached to Vercel Fluid Compute.
    this.connected = false;
    this.connectPromise = null;
  }

  async subscribe(threadId: string): Promise<void> {
    this.ensureConnected();
    await this.pool.query(
      `INSERT INTO chat_state_subscriptions (key_prefix, thread_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [this.keyPrefix, threadId],
    );
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.ensureConnected();
    await this.pool.query(
      `DELETE FROM chat_state_subscriptions
       WHERE key_prefix = $1 AND thread_id = $2`,
      [this.keyPrefix, threadId],
    );
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    this.ensureConnected();
    const result = await this.pool.query(
      `SELECT 1 FROM chat_state_subscriptions
       WHERE key_prefix = $1 AND thread_id = $2
       LIMIT 1`,
      [this.keyPrefix, threadId],
    );
    return result.rowCount === 1;
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    this.ensureConnected();
    const token = `pg_${randomUUID()}`;
    const result = await this.pool.query<{
      expires_at: Date;
      thread_id: string;
      token: string;
    }>(
      `INSERT INTO chat_state_locks
         (key_prefix, thread_id, token, expires_at)
       VALUES ($1, $2, $3, now() + $4 * interval '1 millisecond')
       ON CONFLICT (key_prefix, thread_id) DO UPDATE
         SET token = EXCLUDED.token,
             expires_at = EXCLUDED.expires_at,
             updated_at = now()
         WHERE chat_state_locks.expires_at <= now()
       RETURNING thread_id, token, expires_at`,
      [this.keyPrefix, threadId, token, ttlMs],
    );
    const row = result.rows[0];
    return row
      ? {
          expiresAt: row.expires_at.getTime(),
          threadId: row.thread_id,
          token: row.token,
        }
      : null;
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.ensureConnected();
    await this.pool.query(
      `DELETE FROM chat_state_locks
       WHERE key_prefix = $1 AND thread_id = $2`,
      [this.keyPrefix, threadId],
    );
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.ensureConnected();
    await this.pool.query(
      `DELETE FROM chat_state_locks
       WHERE key_prefix = $1 AND thread_id = $2 AND token = $3`,
      [this.keyPrefix, lock.threadId, lock.token],
    );
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    this.ensureConnected();
    const result = await this.pool.query(
      `UPDATE chat_state_locks
       SET expires_at = now() + $1 * interval '1 millisecond',
           updated_at = now()
       WHERE key_prefix = $2
         AND thread_id = $3
         AND token = $4
         AND expires_at > now()
       RETURNING thread_id`,
      [ttlMs, this.keyPrefix, lock.threadId, lock.token],
    );
    return result.rowCount === 1;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    this.ensureConnected();
    const result = await this.pool.query<{ value: string }>(
      `SELECT value FROM chat_state_cache
       WHERE key_prefix = $1 AND cache_key = $2
         AND (expires_at IS NULL OR expires_at > now())
       LIMIT 1`,
      [this.keyPrefix, key],
    );
    const row = result.rows[0];
    if (row) return parse<T>(row.value);

    await this.pool.query(
      `DELETE FROM chat_state_cache
       WHERE key_prefix = $1 AND cache_key = $2 AND expires_at <= now()`,
      [this.keyPrefix, key],
    );
    return null;
  }

  async set<T = unknown>(
    key: string,
    value: T,
    ttlMs?: number,
  ): Promise<void> {
    this.ensureConnected();
    await this.pool.query(
      `INSERT INTO chat_state_cache
         (key_prefix, cache_key, value, expires_at)
       VALUES (
         $1,
         $2,
         $3,
         CASE
           WHEN $4::bigint IS NULL THEN NULL
           ELSE now() + $4 * interval '1 millisecond'
         END
       )
       ON CONFLICT (key_prefix, cache_key) DO UPDATE
         SET value = EXCLUDED.value,
             expires_at = EXCLUDED.expires_at,
             updated_at = now()`,
      [this.keyPrefix, key, serialize(value), ttlMs ?? null],
    );
  }

  async setIfNotExists(
    key: string,
    value: unknown,
    ttlMs?: number,
  ): Promise<boolean> {
    this.ensureConnected();
    const result = await this.pool.query(
      `INSERT INTO chat_state_cache
         (key_prefix, cache_key, value, expires_at)
       VALUES (
         $1,
         $2,
         $3,
         CASE
           WHEN $4::bigint IS NULL THEN NULL
           ELSE now() + $4 * interval '1 millisecond'
         END
       )
       ON CONFLICT (key_prefix, cache_key) DO UPDATE
         SET value = EXCLUDED.value,
             expires_at = EXCLUDED.expires_at,
             updated_at = now()
         WHERE chat_state_cache.expires_at IS NOT NULL
           AND chat_state_cache.expires_at <= now()
       RETURNING cache_key`,
      [this.keyPrefix, key, serialize(value), ttlMs ?? null],
    );
    return result.rowCount === 1;
  }

  async delete(key: string): Promise<void> {
    this.ensureConnected();
    await this.pool.query(
      `DELETE FROM chat_state_cache
       WHERE key_prefix = $1 AND cache_key = $2`,
      [this.keyPrefix, key],
    );
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    this.ensureConnected();
    await this.withKeyTransaction("list", key, async (client) => {
      await client.query(
        `DELETE FROM chat_state_lists
         WHERE key_prefix = $1 AND list_key = $2 AND expires_at <= now()`,
        [this.keyPrefix, key],
      );

      const existing = await client.query<{ expires_at: Date | null }>(
        `SELECT expires_at FROM chat_state_lists
         WHERE key_prefix = $1 AND list_key = $2
         ORDER BY seq DESC
         LIMIT 1`,
        [this.keyPrefix, key],
      );
      const inserted = await client.query<{ expires_at: Date | null }>(
        `INSERT INTO chat_state_lists
           (key_prefix, list_key, value, expires_at)
         VALUES (
           $1,
           $2,
           $3,
           CASE
             WHEN $4::bigint IS NOT NULL
               THEN now() + $4 * interval '1 millisecond'
             ELSE $5::timestamptz
           END
         )
         RETURNING expires_at`,
        [
          this.keyPrefix,
          key,
          serialize(value),
          options?.ttlMs ?? null,
          existing.rows[0]?.expires_at ?? null,
        ],
      );

      if (options?.maxLength && options.maxLength > 0) {
        await client.query(
          `DELETE FROM chat_state_lists
           WHERE key_prefix = $1 AND list_key = $2 AND seq IN (
             SELECT seq FROM chat_state_lists
             WHERE key_prefix = $1 AND list_key = $2
             ORDER BY seq DESC
             OFFSET $3
           )`,
          [this.keyPrefix, key, options.maxLength],
        );
      }

      const expiresAt = inserted.rows[0]?.expires_at ?? null;
      if (expiresAt) {
        await client.query(
          `UPDATE chat_state_lists
           SET expires_at = $3
           WHERE key_prefix = $1 AND list_key = $2`,
          [this.keyPrefix, key, expiresAt],
        );
      }
    });
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    this.ensureConnected();
    return this.withKeyTransaction("list", key, async (client) => {
      await client.query(
        `DELETE FROM chat_state_lists
         WHERE key_prefix = $1 AND list_key = $2 AND expires_at <= now()`,
        [this.keyPrefix, key],
      );
      const result = await client.query<{ value: string }>(
        `SELECT value FROM chat_state_lists
         WHERE key_prefix = $1 AND list_key = $2
         ORDER BY seq ASC`,
        [this.keyPrefix, key],
      );
      return result.rows.map((row) => parse<T>(row.value));
    });
  }

  async enqueue(
    threadId: string,
    entry: QueueEntry,
    maxSize: number,
  ): Promise<number> {
    this.ensureConnected();
    return this.withKeyTransaction("queue", threadId, async (client) => {
      await client.query(
        `DELETE FROM chat_state_queues
         WHERE key_prefix = $1 AND thread_id = $2 AND expires_at <= now()`,
        [this.keyPrefix, threadId],
      );
      await client.query(
        `INSERT INTO chat_state_queues
           (key_prefix, thread_id, value, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [
          this.keyPrefix,
          threadId,
          serialize(entry),
          new Date(entry.expiresAt),
        ],
      );

      if (maxSize > 0) {
        await client.query(
          `DELETE FROM chat_state_queues
           WHERE key_prefix = $1 AND thread_id = $2 AND seq IN (
             SELECT seq FROM chat_state_queues
             WHERE key_prefix = $1 AND thread_id = $2
             ORDER BY seq DESC
             OFFSET $3
           )`,
          [this.keyPrefix, threadId, maxSize],
        );
      }

      const result = await client.query<{ depth: string }>(
        `SELECT count(*) AS depth FROM chat_state_queues
         WHERE key_prefix = $1 AND thread_id = $2 AND expires_at > now()`,
        [this.keyPrefix, threadId],
      );
      return Number.parseInt(result.rows[0]?.depth ?? "0", 10);
    });
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    this.ensureConnected();
    return this.withKeyTransaction("queue", threadId, async (client) => {
      await client.query(
        `DELETE FROM chat_state_queues
         WHERE key_prefix = $1 AND thread_id = $2 AND expires_at <= now()`,
        [this.keyPrefix, threadId],
      );
      const result = await client.query<{ value: string }>(
        `DELETE FROM chat_state_queues
         WHERE key_prefix = $1 AND thread_id = $2
           AND seq = (
             SELECT seq FROM chat_state_queues
             WHERE key_prefix = $1 AND thread_id = $2
             ORDER BY seq ASC
             LIMIT 1
           )
         RETURNING value`,
        [this.keyPrefix, threadId],
      );
      const row = result.rows[0];
      return row ? parse<QueueEntry>(row.value) : null;
    });
  }

  async queueDepth(threadId: string): Promise<number> {
    this.ensureConnected();
    const result = await this.pool.query<{ depth: string }>(
      `SELECT count(*) AS depth FROM chat_state_queues
       WHERE key_prefix = $1 AND thread_id = $2 AND expires_at > now()`,
      [this.keyPrefix, threadId],
    );
    return Number.parseInt(result.rows[0]?.depth ?? "0", 10);
  }

  private async withKeyTransaction<T>(
    scope: "list" | "queue",
    key: string,
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${this.keyPrefix}:${scope}:${key}`],
      );
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error(
        "BurnModePostgresState is not connected. Call connect() first.",
      );
    }
  }
}

/**
 * Chat SDK needs shared state for webhook deduplication, thread locks, queues,
 * subscriptions, and Burn Mode delivery claims. Memory is local-dev only.
 */
export function createBurnModeChatState(): StateAdapter {
  if (process.env.DATABASE_URL?.trim()) {
    const { pool } = getBurnModeDatabase();
    return new BurnModePostgresState(
      pool,
      `burn-mode:sendblue:${deploymentNamespace()}`,
    );
  }

  const isHostedVercel =
    process.env.VERCEL === "1" && process.env.VERCEL_ENV !== "development";

  if (isHostedVercel) {
    throw new Error(
      "DATABASE_URL is required for durable Sendblue chat state on Vercel.",
    );
  }

  return createMemoryState();
}
