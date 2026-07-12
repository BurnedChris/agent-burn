import { createHash } from "node:crypto";

import type { UserContent } from "ai";
import {
  Message,
  type Channel,
  type Lock,
  type MessageContext,
  type QueueEntry,
  type StateAdapter,
  type Thread,
} from "chat";
import {
  isCurrentTurnBoundaryEvent,
  type InputRequest,
  type InputResponse,
} from "eve/client";
import type { Session } from "eve/channels";
import {
  chatSdkChannel,
  messageToUserContent,
} from "eve/channels/chat-sdk";
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";

import { createBurnModeChatState } from "../lib/chat-state";
import { ConnectSendblueAdapter } from "../lib/connect-sendblue-adapter";

const e164Schema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/u, "Expected an E.164 phone number.");

const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9:._-]+$/u);

const proactiveMessageSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  message: z.string().trim().min(1).max(2_000),
});

const proactiveContextSchema = z.object({
  attemptedAt: z.string(),
  idempotencyKey: idempotencyKeySchema,
  message: z.string().min(1).max(2_000),
});

const sessionCursorSchema = z.object({
  nextIndex: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
});

const pendingTextOptionSchema = z.object({
  description: z.string().optional(),
  id: z.string(),
  label: z.string(),
});

const pendingTextRequestSchema = z.object({
  allowFreeform: z.boolean().optional(),
  options: z.array(pendingTextOptionSchema).optional(),
  prompt: z.string(),
  requestId: z.string(),
});

const pendingTextBatchSchema = z.object({
  requests: z.array(pendingTextRequestSchema).min(2),
});

type PendingTextRequest = z.infer<typeof pendingTextRequestSchema>;
type PendingTextBatch = z.infer<typeof pendingTextBatchSchema>;
type ProactiveContext = z.infer<typeof proactiveContextSchema>;

const PENDING_MULTI_INPUT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const PROACTIVE_DELIVERY_TTL_MS = 72 * 60 * 60 * 1_000;
const SESSION_LEASE_TTL_MS = 60_000;
const SESSION_LEASE_RENEW_MS = 20_000;
const SESSION_LEASE_WAIT_MS = 10 * 60 * 1_000;
const SESSION_QUEUE_TTL_MS = 60 * 60 * 1_000;
const SESSION_QUEUE_MAX_SIZE = 50;
const sendblueAdapter = new ConnectSendblueAdapter();

function isChristopher(phone: string): boolean {
  const configured = e164Schema.safeParse(process.env.BURN_MODE_PHONE_NUMBER);
  return configured.success && configured.data === phone;
}

function authForChristopher(phone: string): SessionAuthContext {
  const principal = createHash("sha256")
    .update(phone)
    .digest("base64url")
    .slice(0, 24);

  return {
    authenticator: "sendblue-webhook",
    issuer: "sendblue",
    principalId: `sendblue:${principal}`,
    principalType: "user",
    attributes: { channel: "sendblue" },
  };
}

function pendingInputKey(threadId: string): string {
  const digest = createHash("sha256").update(threadId).digest("base64url");
  return `burn-mode:pending-multi-input:${digest}`;
}

function proactiveContextKey(threadId: string): string {
  const digest = createHash("sha256").update(threadId).digest("base64url");
  return `burn-mode:proactive-context:${digest}`;
}

function sessionCursorKey(threadId: string): string {
  const digest = createHash("sha256").update(threadId).digest("base64url");
  return `burn-mode:session-cursor:${digest}`;
}

function sessionLeaseKey(threadId: string): string {
  const digest = createHash("sha256").update(threadId).digest("base64url");
  return `burn-mode:session-lease:${digest}`;
}

function sessionQueueKey(threadId: string): string {
  const digest = createHash("sha256").update(threadId).digest("base64url");
  return `burn-mode:session-queue:${digest}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSessionLease(
  state: StateAdapter,
  threadId: string,
): Promise<Lock> {
  const key = sessionLeaseKey(threadId);
  const deadline = Date.now() + SESSION_LEASE_WAIT_MS;

  do {
    const lock = await state.acquireLock(key, SESSION_LEASE_TTL_MS);
    if (lock) return lock;
    await delay(250);
  } while (Date.now() < deadline);

  throw new Error("Timed out waiting for the prior Burn Mode turn to finish.");
}

function startLeaseRenewal(state: StateAdapter, lock: Lock): {
  assertHeld(): void;
  stop(): void;
} {
  let leaseLost = false;
  const timer = setInterval(() => {
    void state
      .extendLock(lock, SESSION_LEASE_TTL_MS)
      .then((extended) => {
        if (!extended) leaseLost = true;
      })
      .catch(() => {
        leaseLost = true;
      });
  }, SESSION_LEASE_RENEW_MS);

  return {
    assertHeld() {
      if (leaseLost) {
        throw new Error("Burn Mode lost its durable session delivery lease.");
      }
    },
    stop() {
      clearInterval(timer);
    },
  };
}

async function enqueueInboundMessages(
  state: StateAdapter,
  threadId: string,
  messages: readonly Message[],
): Promise<void> {
  const now = Date.now();
  for (const message of messages) {
    await state.enqueue(
      sessionQueueKey(threadId),
      {
        message,
        enqueuedAt: now,
        expiresAt: now + SESSION_QUEUE_TTL_MS,
      },
      SESSION_QUEUE_MAX_SIZE,
    );
  }
}

function restoreQueuedMessage(entry: QueueEntry): Message {
  const value = entry.message as unknown;
  if (
    value instanceof Message ||
    (typeof value === "object" &&
      value !== null &&
      "toJSON" in value &&
      typeof value.toJSON === "function")
  ) {
    return value as Message;
  }
  return Message.fromJSON(value as ReturnType<Message["toJSON"]>);
}

async function drainInboundQueue(
  state: StateAdapter,
  threadId: string,
): Promise<Message[]> {
  const messages: Message[] = [];
  let entry: QueueEntry | null;

  while ((entry = await state.dequeue(sessionQueueKey(threadId)))) {
    if (entry.expiresAt <= Date.now()) continue;
    const message = restoreQueuedMessage(entry);
    if (
      message.author.isMe ||
      message.author.isBot === true ||
      !isChristopher(message.author.userId)
    ) {
      continue;
    }
    messages.push(message);
  }

  return messages;
}

function toPendingTextRequest(request: InputRequest): PendingTextRequest {
  return {
    requestId: request.requestId,
    prompt: request.prompt,
    allowFreeform: request.allowFreeform,
    options: request.options?.map(({ description, id, label }) => ({
      description,
      id,
      label,
    })),
  };
}

function resolveTextResponse(
  text: string,
  request: PendingTextRequest,
): InputResponse | undefined {
  const answer = text.trim();
  if (!answer) return undefined;

  const normalized = answer.toLocaleLowerCase("en");
  const options = request.options ?? [];
  const exactOption = options.find(
    (option) =>
      option.id.toLocaleLowerCase("en") === normalized ||
      option.label.toLocaleLowerCase("en") === normalized,
  );
  if (exactOption) {
    return { requestId: request.requestId, optionId: exactOption.id };
  }

  if (/^[1-9]\d*$/u.test(answer)) {
    const indexedOption = options[Number(answer) - 1];
    if (indexedOption) {
      return { requestId: request.requestId, optionId: indexedOption.id };
    }
  }

  if (request.allowFreeform === true || options.length === 0) {
    return { requestId: request.requestId, text: answer };
  }

  return undefined;
}

function parseIndexedResponses(
  text: string,
  batch: PendingTextBatch,
): readonly InputResponse[] | null {
  const lines = text
    .split(/[;\n]+/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== batch.requests.length) return null;

  const responses = new Map<number, InputResponse>();
  for (const line of lines) {
    const match = /^(\d+)\s*[:.)-]\s*(.+)$/u.exec(line);
    if (!match) return null;

    const index = Number(match[1]) - 1;
    const request = batch.requests[index];
    if (!request || responses.has(index)) return null;

    const response = resolveTextResponse(match[2], request);
    if (!response) return null;
    responses.set(index, response);
  }

  if (responses.size !== batch.requests.length) return null;
  return batch.requests.map((_, index) => responses.get(index)!);
}

function answerMatchesAnyRequest(
  text: string,
  batch: PendingTextBatch,
): boolean {
  return batch.requests.some(
    (request) => resolveTextResponse(text, request) !== undefined,
  );
}

async function getPendingTextBatch(
  threadId: string,
): Promise<PendingTextBatch | null> {
  const value = await bot.getState().get(pendingInputKey(threadId));
  const parsed = pendingTextBatchSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function getProactiveContext(
  threadId: string,
): Promise<ProactiveContext | null> {
  const value = await bot.getState().get(proactiveContextKey(threadId));
  const parsed = proactiveContextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function waitForSessionBoundary(
  session: Session,
  threadId: string,
  turnStartedAfterMs: number,
): Promise<void> {
  const state = bot.getState();
  const key = sessionCursorKey(threadId);
  const stored = sessionCursorSchema.safeParse(await state.get(key));
  const startIndex =
    stored.success && stored.data.sessionId === session.id
      ? stored.data.nextIndex
      : 0;
  const stream = await session.getEventStream({ startIndex });
  let nextIndex = startIndex;
  let currentTurnObserved = false;

  for await (const event of stream) {
    nextIndex += 1;
    const isBoundary = isCurrentTurnBoundaryEvent(event);
    if (event.type === "turn.started") {
      const eventTime = Date.parse(event.meta?.at ?? "");
      // Ignore a replayed boundary from an older turn after process recovery.
      if (Number.isFinite(eventTime) && eventTime >= turnStartedAfterMs) {
        currentTurnObserved = true;
      }
    }
    if (isBoundary || nextIndex % 25 === 0) {
      await state.set(key, { nextIndex, sessionId: session.id });
    }
    if (!isBoundary || !currentTurnObserved) continue;
    return;
  }

  throw new Error("Eve session stream ended before a turn boundary.");
}

function formatActionDetails(request: InputRequest): string | null {
  const optionIds = new Set(request.options?.map((option) => option.id) ?? []);
  if (!optionIds.has("approve") || !optionIds.has("deny")) return null;

  const serialized = JSON.stringify(request.action.input, null, 2);
  const maxLength = 1_800;
  const details =
    serialized.length <= maxLength
      ? serialized
      : `${serialized.slice(0, maxLength)}\n[Details truncated. Reply deny and review in Eve before approving.]`;
  return `Proposed ${request.action.toolName}:\n${details}`;
}

function messagesToUserContent(messages: readonly Message[]): string | UserContent {
  if (messages.length === 1) return messageToUserContent(messages[0]);

  const content: UserContent = [];
  for (const message of messages) {
    const converted = messageToUserContent(message);
    if (typeof converted === "string") {
      if (converted.trim()) content.push({ type: "text", text: converted });
    } else {
      content.push(...converted);
    }
  }
  return content;
}

export const { bot, channel, send } = chatSdkChannel({
  userName: "Burn Mode",
  adapters: { sendblue: sendblueAdapter },
  state: createBurnModeChatState(),
  routes: { sendblue: "/eve/v1/sendblue" },
  concurrency: {
    strategy: "burst",
    debounceMs: 1_500,
    maxQueueSize: 20,
    onQueueFull: "drop-oldest",
    queueEntryTtlMs: 120_000,
  },
  // Sendblue cannot edit a delivered iMessage. Post one final reply per turn.
  streaming: false,
  events: {
    async "input.requested"({ requests }, context) {
      if (!context.thread || requests.length === 0) return;

      const key = pendingInputKey(context.thread.id);
      if (requests.length > 1) {
        await bot.getState().set(
          key,
          { requests: requests.map(toPendingTextRequest) },
          PENDING_MULTI_INPUT_TTL_MS,
        );
      } else {
        await bot.getState().delete(key);
      }

      const sections = requests.map((request, requestIndex) => {
        const options = request.options ?? [];
        return [
          requests.length > 1 ? `Request ${requestIndex + 1}:` : null,
          request.prompt,
          formatActionDetails(request),
          options.length > 0
            ? options
                .map(
                  (option, optionIndex) =>
                    `${optionIndex + 1}. ${option.label}${
                      option.description ? ` — ${option.description}` : ""
                    }`,
                )
                .join("\n")
            : null,
          requests.length === 1 && options.length > 0
            ? "Reply with the option number or name."
            : requests.length === 1
              ? "Reply with your answer."
              : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n");
      });

      if (requests.length > 1) {
        sections.push(
          "Reply to every request separately, one per line—for example:\n1: approve\n2: deny\nA single approval will not be applied to the whole batch.",
        );
      }

      await context.thread.post(sections.join("\n\n"));
    },
  },
});

async function processInboundBatch(
  thread: Thread,
  messages: readonly Message[],
  sender: string,
): Promise<void> {
  const combinedText = messages
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const pendingBatch = await getPendingTextBatch(thread.id);

  if (pendingBatch) {
    const responses = parseIndexedResponses(combinedText, pendingBatch);
    if (responses) {
      const state = bot.getState();
      const key = pendingInputKey(thread.id);
      await state.delete(key);

      let session: Session;
      const turnStartedAfterMs = Date.now();
      try {
        session = await send(
          { inputResponses: responses },
          {
            thread,
            auth: authForChristopher(sender),
            mode: "conversation",
            title: "Burn Mode",
          },
        );
      } catch (error) {
        await state
          .setIfNotExists(key, pendingBatch, PENDING_MULTI_INPUT_TTL_MS)
          .catch(() => undefined);
        await enqueueInboundMessages(state, thread.id, messages).catch(
          () => undefined,
        );
        throw error;
      }
      await waitForSessionBoundary(
        session,
        thread.id,
        turnStartedAfterMs,
      );
      return;
    }

    if (
      answerMatchesAnyRequest(combinedText, pendingBatch) ||
      /^\s*\d+\s*[:.)-]/u.test(combinedText)
    ) {
      try {
        await thread.post(
          "For safety, answer every request separately—one per line, like `1: approve` and `2: deny`.",
        );
      } catch (error) {
        await enqueueInboundMessages(bot.getState(), thread.id, messages).catch(
          () => undefined,
        );
        throw error;
      }
      return;
    }
    // Eve holds unrelated text and replays it after the approvals are answered.
  }

  const proactiveContext = await getProactiveContext(thread.id);
  const state = bot.getState();
  const contextKey = proactiveContextKey(thread.id);
  if (proactiveContext) await state.delete(contextKey);

  let session: Session;
  const turnStartedAfterMs = Date.now();
  try {
    const input = messagesToUserContent(messages);
    session = await send(
      proactiveContext
        ? {
            message: input,
            context: [
              `Immediately before this reply, Burn Mode attempted to send this scheduled check-in over Sendblue: ${JSON.stringify(proactiveContext.message)}. Interpret Christopher's reply in that context when relevant.`,
            ],
          }
        : input,
      {
        thread,
        auth: authForChristopher(sender),
        mode: "conversation",
        title: "Burn Mode",
      },
    );
  } catch (error) {
    if (proactiveContext) {
      await state
        .setIfNotExists(
          contextKey,
          proactiveContext,
          PROACTIVE_DELIVERY_TTL_MS,
        )
          .catch(() => undefined);
    }
    await enqueueInboundMessages(state, thread.id, messages).catch(
      () => undefined,
    );
    throw error;
  }
  await waitForSessionBoundary(session, thread.id, turnStartedAfterMs);
}

bot.onDirectMessage(
  async (
    thread: Thread,
    message: Message,
    _channel: Channel,
    context?: MessageContext,
  ) => {
    const sender = message.author.userId;
    if (
      message.author.isMe ||
      message.author.isBot === true ||
      !isChristopher(sender)
    ) {
      return;
    }

    const state = bot.getState();
    const messages = [...(context?.skipped ?? []), message];
    await enqueueInboundMessages(state, thread.id, messages);

    const lease = await acquireSessionLease(state, thread.id);
    const renewal = startLeaseRenewal(state, lease);
    try {
      while (true) {
        renewal.assertHeld();
        const queued = await drainInboundQueue(state, thread.id);
        if (queued.length === 0) return;

        await processInboundBatch(thread, queued, queued.at(-1)!.author.userId);
        renewal.assertHeld();
      }
    } finally {
      renewal.stop();
      await state.releaseLock(lease);
    }
  },
);

/** Post one exact scheduled check-in and retain context for the next reply. */
export async function sendProactiveMessage(input: {
  idempotencyKey: string;
  message: string;
}): Promise<void> {
  const parsed = proactiveMessageSchema.parse(input);
  await bot.initialize();

  if (await sendblueAdapter.isProactiveDeliveryDisabled()) return;
  const threadId = await sendblueAdapter.configuredDirectThreadId();

  const state = bot.getState();
  const deliveryKey = `burn-mode:delivery:${parsed.idempotencyKey}`;
  const claimed = await state.setIfNotExists(
    deliveryKey,
    { claimedAt: new Date().toISOString() },
    PROACTIVE_DELIVERY_TTL_MS,
  );
  if (!claimed) return;

  const proactiveContext: ProactiveContext = {
    attemptedAt: new Date().toISOString(),
    idempotencyKey: parsed.idempotencyKey,
    message: parsed.message,
  };
  try {
    await state.set(
      proactiveContextKey(threadId),
      proactiveContext,
      PROACTIVE_DELIVERY_TTL_MS,
    );
  } catch (error) {
    // No provider call has happened yet, so this claim is safe to release.
    await state.delete(deliveryKey).catch(() => undefined);
    throw error;
  }

  // The claim deliberately survives ambiguous provider failures so a cron
  // retry cannot double-text Christopher after Sendblue accepted the request.
  await sendblueAdapter.postMessage(threadId, parsed.message);
}

export default channel;
