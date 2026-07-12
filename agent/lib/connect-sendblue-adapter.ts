import { createHash, timingSafeEqual } from "node:crypto";

import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Message,
  RawMessage,
  StreamChunk,
  StreamOptions,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import {
  createSendblueAdapter,
  type SendblueAdapter,
  type SendblueMessagePayload,
  type SendblueThreadId,
} from "chat-adapter-sendblue";

import {
  resolveSendblueCredentials,
  resolveSendblueWebhookConfig,
  type SendblueCredentials,
  type SendblueWebhookConfig,
} from "./sendblue-credentials";

const SENDBLUE_WEBHOOK_SECRET_HEADER = "sb-signing-secret";
const E164_PATTERN = /^\+[1-9]\d{7,14}$/u;
const PROACTIVE_DISABLED_STATE_KEY = "burn-mode:proactive-disabled";
const OPT_OUT_WORDS = new Set([
  "CANCEL",
  "END",
  "QUIT",
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
]);
const OPT_IN_WORDS = new Set(["START", "UNSTOP"]);

type JsonRecord = Record<string, unknown>;

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString();
}

function requireE164(value: string, field: string): string {
  if (!E164_PATTERN.test(value)) {
    throw new Error(`Invalid ${field} in Sendblue thread ID.`);
  }
  return value;
}

export function encodeSendblueThreadId(data: SendblueThreadId): string {
  const fromNumber = requireE164(data.fromNumber, "from number");
  const from = Buffer.from(fromNumber).toString("base64url");

  if (data.groupId) {
    return `sendblue:${from}:g:${Buffer.from(data.groupId).toString("base64url")}`;
  }

  const contactNumber = requireE164(
    data.contactNumber ?? "",
    "contact number",
  );
  const contact = Buffer.from(contactNumber).toString("base64url");
  return `sendblue:${from}:${contact}`;
}

export function decodeSendblueThreadId(threadId: string): SendblueThreadId {
  const parts = threadId.split(":");

  if (parts.length === 4 && parts[0] === "sendblue" && parts[2] === "g") {
    const groupId = decodeBase64Url(parts[3]);
    if (!groupId) throw new Error("Invalid group ID in Sendblue thread ID.");
    return {
      fromNumber: requireE164(decodeBase64Url(parts[1]), "from number"),
      groupId,
    };
  }

  if (parts.length === 3 && parts[0] === "sendblue" && parts[2] !== "g") {
    return {
      fromNumber: requireE164(decodeBase64Url(parts[1]), "from number"),
      contactNumber: requireE164(
        decodeBase64Url(parts[2]),
        "contact number",
      ),
    };
  }

  throw new Error("Invalid Sendblue thread ID.");
}

function secretsMatch(provided: string | null, expected: string): boolean {
  if (!provided || provided.length > 4_096) return false;

  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function directMessageLine(payload: JsonRecord): string | undefined {
  const sendblueNumber = readString(payload, "sendblue_number");
  return sendblueNumber || readString(payload, "to_number");
}

function isOneToOnePayload(payload: JsonRecord): boolean {
  const groupId = payload.group_id;
  return groupId === undefined || groupId === null || groupId === "";
}

function isAllowedInboundMessage(
  payload: JsonRecord,
  config: SendblueWebhookConfig,
): boolean {
  return (
    payload.is_outbound === false &&
    isOneToOnePayload(payload) &&
    readString(payload, "from_number") === config.allowedContactNumber &&
    directMessageLine(payload) === config.defaultFromNumber
  );
}

function isAllowedOutboundEvent(
  payload: JsonRecord,
  config: SendblueWebhookConfig,
): boolean {
  const fromNumber =
    readString(payload, "sendblue_number") ||
    readString(payload, "from_number");
  const contactNumber =
    readString(payload, "to_number") || readString(payload, "number");

  return (
    payload.is_outbound === true &&
    isOneToOnePayload(payload) &&
    fromNumber === config.defaultFromNumber &&
    contactNumber === config.allowedContactNumber
  );
}

function okResponse(): Response {
  return new Response("OK", {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * The published Sendblue adapter accepts only synchronous credentials. This
 * wrapper resolves the API secret from Vercel Connect only after a webhook has
 * passed local verification, then delegates the standard adapter surface.
 */
export class ConnectSendblueAdapter
  implements Adapter<SendblueThreadId, SendblueMessagePayload>
{
  readonly name = "sendblue";
  readonly persistMessageHistory = true;
  readonly userName = "Burn Mode";

  private chat: ChatInstance | null = null;
  private credentials: SendblueCredentials | null = null;
  private delegate: SendblueAdapter | null = null;
  private delegateInitialization: Promise<void> | null = null;

  async initialize(chat: ChatInstance): Promise<void> {
    // Keep Chat SDK initialization local and retryable. Connect is consulted
    // later, after webhook verification or immediately before outbound use.
    this.chat = chat;
  }

  private requireChat(): ChatInstance {
    if (!this.chat) {
      throw new Error("Sendblue adapter has not been initialized by Chat SDK.");
    }
    return this.chat;
  }

  private async ensureDelegate(): Promise<SendblueAdapter> {
    if (this.delegate) return this.delegate;

    if (!this.delegateInitialization) {
      this.delegateInitialization = this.initializeDelegate().catch((error) => {
        this.delegateInitialization = null;
        throw error;
      });
    }

    await this.delegateInitialization;
    if (!this.delegate) {
      throw new Error("Sendblue adapter initialization did not complete.");
    }
    return this.delegate;
  }

  private async initializeDelegate(): Promise<void> {
    const credentials = await resolveSendblueCredentials();
    const delegate = createSendblueAdapter({
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      defaultFromNumber: credentials.defaultFromNumber,
      // Accept replies when Sendblue falls back from iMessage.
      allowedServices: ["iMessage", "SMS", "RCS"],
      // Verification is handled below with a timing-safe comparison.
      webhookSecret: undefined,
    });

    // chat-adapter-sendblue 0.2.0 documents direct-message handlers but does
    // not expose Chat SDK's optional isDM hook. Its webhook processor passes
    // this delegate instance back to Chat SDK, so attach the missing hook.
    const delegateWithDirectMessageSupport = delegate as SendblueAdapter & {
      isDM(threadId: string): boolean;
    };
    delegateWithDirectMessageSupport.isDM = (threadId) => this.isDM(threadId);

    await delegate.initialize(this.requireChat());
    this.credentials = credentials;
    this.delegate = delegate;
  }

  private async filterVerifiedWebhook(
    request: Request,
    config: SendblueWebhookConfig,
  ): Promise<Response | null> {
    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      return new Response("Bad Request", {
        status: 400,
        headers: { "cache-control": "no-store" },
      });
    }
    if (!isRecord(body)) {
      return new Response("Bad Request", {
        status: 400,
        headers: { "cache-control": "no-store" },
      });
    }

    if (typeof body.message_handle === "string") {
      if (body.is_outbound === false) {
        if (!isAllowedInboundMessage(body, config)) return okResponse();

        const normalizedContent =
          readString(body, "content")?.trim().toLocaleUpperCase("en") ?? "";
        const state = this.requireChat().getState();

        if (body.opted_out === true || OPT_OUT_WORDS.has(normalizedContent)) {
          await state.set(PROACTIVE_DISABLED_STATE_KEY, {
            disabledAt: new Date().toISOString(),
          });
          return okResponse();
        }

        if (OPT_IN_WORDS.has(normalizedContent)) {
          await state.delete(PROACTIVE_DISABLED_STATE_KEY);
        }
        return null;
      }

      if (body.is_outbound === true && !isAllowedOutboundEvent(body, config)) {
        return okResponse();
      }
      return body.is_outbound === true ? null : okResponse();
    }

    if (typeof body.is_typing === "boolean") {
      const isAllowedTypingEvent =
        readString(body, "number") === config.allowedContactNumber &&
        readString(body, "from_number") === config.defaultFromNumber;
      return isAllowedTypingEvent ? null : okResponse();
    }

    return okResponse();
  }

  async handleWebhook(
    request: Request,
    options?: WebhookOptions,
  ): Promise<Response> {
    const webhookConfig = resolveSendblueWebhookConfig();
    if (
      !secretsMatch(
        request.headers.get(SENDBLUE_WEBHOOK_SECRET_HEADER),
        webhookConfig.webhookSecret,
      )
    ) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "cache-control": "no-store" },
      });
    }

    const filtered = await this.filterVerifiedWebhook(request, webhookConfig);
    if (filtered) return filtered;

    const delegate = await this.ensureDelegate();
    return delegate.handleWebhook(request, options);
  }

  async disconnect(): Promise<void> {
    await this.delegate?.disconnect();
    this.delegate = null;
    this.credentials = null;
    this.delegateInitialization = null;
  }

  encodeThreadId(data: SendblueThreadId): string {
    return encodeSendblueThreadId(data);
  }

  decodeThreadId(threadId: string): SendblueThreadId {
    return decodeSendblueThreadId(threadId);
  }

  isDM(threadId: string): boolean {
    try {
      return !decodeSendblueThreadId(threadId).groupId;
    } catch {
      return false;
    }
  }

  channelIdFromThreadId(threadId: string): string {
    const parts = threadId.split(":");
    return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : "sendblue";
  }

  async configuredDirectThreadId(): Promise<string> {
    await this.ensureDelegate();
    if (!this.credentials) {
      throw new Error("Sendblue credentials are unavailable.");
    }
    return encodeSendblueThreadId({
      fromNumber: this.credentials.defaultFromNumber,
      contactNumber: this.credentials.allowedContactNumber,
    });
  }

  async isProactiveDeliveryDisabled(): Promise<boolean> {
    const value = await this.requireChat()
      .getState()
      .get(PROACTIVE_DISABLED_STATE_KEY);
    return isRecord(value) && typeof value.disabledAt === "string";
  }

  parseMessage(raw: SendblueMessagePayload): Message<SendblueMessagePayload> {
    if (!this.delegate) {
      throw new Error("Sendblue adapter has not been initialized.");
    }
    return this.delegate.parseMessage(raw);
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<SendblueMessagePayload>> {
    return (await this.ensureDelegate()).postMessage(threadId, message);
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<SendblueMessagePayload>> {
    return (await this.ensureDelegate()).editMessage(
      threadId,
      messageId,
      message,
    );
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    return (await this.ensureDelegate()).deleteMessage(threadId, messageId);
  }

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    return (await this.ensureDelegate()).addReaction(
      threadId,
      messageId,
      emoji,
    );
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    return (await this.ensureDelegate()).removeReaction(
      threadId,
      messageId,
      emoji,
    );
  }

  async fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<SendblueMessagePayload>> {
    return (await this.ensureDelegate()).fetchMessages(threadId, options);
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    return (await this.ensureDelegate()).fetchThread(threadId);
  }

  async startTyping(threadId: string): Promise<void> {
    return (await this.ensureDelegate()).startTyping(threadId);
  }

  renderFormatted(content: FormattedContent): string {
    if (!this.delegate) {
      throw new Error("Sendblue adapter has not been initialized.");
    }
    return this.delegate.renderFormatted(content);
  }

  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    options?: StreamOptions,
  ): Promise<RawMessage<SendblueMessagePayload> | null> {
    return (await this.ensureDelegate()).stream(threadId, textStream, options);
  }
}
