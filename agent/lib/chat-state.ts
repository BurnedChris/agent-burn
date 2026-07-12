import { createMemoryState } from "@chat-adapter/state-memory";
import { createRedisState } from "@chat-adapter/state-redis";
import type { StateAdapter } from "chat";

function stateNamespace(): string {
  const project = process.env.VERCEL_PROJECT_ID?.trim() || "local";
  const environment =
    process.env.VERCEL_TARGET_ENV?.trim() ||
    process.env.VERCEL_ENV?.trim() ||
    "local";
  const safe = (value: string) => value.replace(/[^A-Za-z0-9:_-]/gu, "_");
  return `${safe(project)}:${safe(environment)}`;
}

/**
 * Chat SDK needs shared state for webhook deduplication, thread locks, and
 * subscriptions. Memory is deliberately limited to local development.
 */
export function createBurnModeChatState(): StateAdapter {
  const redisUrl = process.env.REDIS_URL?.trim();

  if (redisUrl) {
    return createRedisState({
      url: redisUrl,
      keyPrefix: `burn-mode:sendblue:${stateNamespace()}`,
    });
  }

  const isHostedVercel =
    process.env.VERCEL === "1" && process.env.VERCEL_ENV !== "development";

  if (isHostedVercel) {
    throw new Error(
      "REDIS_URL is required for durable Sendblue chat state on Vercel.",
    );
  }

  return createMemoryState();
}
