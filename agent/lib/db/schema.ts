import {
  bigserial,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
};

/** Infrastructure tables used by Burn Mode's Postgres Chat SDK adapter. */
export const chatStateSubscriptions = pgTable(
  "chat_state_subscriptions",
  {
    keyPrefix: text("key_prefix").notNull(),
    threadId: text("thread_id").notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.keyPrefix, table.threadId] }),
  ],
);

export const chatStateLocks = pgTable(
  "chat_state_locks",
  {
    keyPrefix: text("key_prefix").notNull(),
    threadId: text("thread_id").notNull(),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.keyPrefix, table.threadId] }),
    index("chat_state_locks_expires_idx").on(table.expiresAt),
  ],
);

export const chatStateCache = pgTable(
  "chat_state_cache",
  {
    keyPrefix: text("key_prefix").notNull(),
    cacheKey: text("cache_key").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.keyPrefix, table.cacheKey] }),
    index("chat_state_cache_expires_idx").on(table.expiresAt),
  ],
);

export const chatStateLists = pgTable(
  "chat_state_lists",
  {
    keyPrefix: text("key_prefix").notNull(),
    listKey: text("list_key").notNull(),
    sequence: bigserial("seq", { mode: "number" }).notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (table) => [
    primaryKey({
      columns: [table.keyPrefix, table.listKey, table.sequence],
    }),
    index("chat_state_lists_expires_idx").on(table.expiresAt),
  ],
);

export const chatStateQueues = pgTable(
  "chat_state_queues",
  {
    keyPrefix: text("key_prefix").notNull(),
    threadId: text("thread_id").notNull(),
    sequence: bigserial("seq", { mode: "number" }).notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.keyPrefix, table.threadId, table.sequence],
    }),
    index("chat_state_queues_expires_idx").on(table.expiresAt),
  ],
);

export type BurnModeEventData = Record<string, unknown>;

/**
 * An append-only personal timeline for choices, check-ins, commitments, and
 * habit outcomes. Add typed projections later without coupling analytics to
 * Chat SDK's expiring infrastructure cache.
 */
export const burnModeEvents = pgTable(
  "burn_mode_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    environment: text("environment").notNull(),
    eventType: text("event_type").notNull(),
    source: text("source").notNull(),
    correlationKey: text("correlation_key"),
    occurredAt: timestamp("occurred_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    data: jsonb("data").$type<BurnModeEventData>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    index("burn_mode_events_type_time_idx").on(
      table.environment,
      table.eventType,
      table.occurredAt,
    ),
    index("burn_mode_events_correlation_idx").on(
      table.environment,
      table.correlationKey,
    ),
  ],
);
