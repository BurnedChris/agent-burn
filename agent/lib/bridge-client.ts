import { z } from "zod";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARACTERS = 256_000;

export const bridgeToolErrorSchema = z.object({
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(240),
  retryable: z.boolean(),
});

export type BridgeToolError = z.infer<typeof bridgeToolErrorSchema>;

type BridgeMethod = "GET" | "POST";
type QueryValue = string | number | boolean | null | undefined;

interface BridgeRequest<TSchema extends z.ZodType> {
  path: string;
  responseSchema: TSchema;
  method?: BridgeMethod;
  query?: Record<string, QueryValue>;
  body?: unknown;
  abortSignal?: AbortSignal;
  idempotencyKey?: string;
}

class BridgeClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    retryable: boolean,
  ) {
    super(message);
    this.name = "BridgeClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

function readConfiguration(): { baseUrl: URL; token: string } {
  const rawUrl = process.env.BURN_MODE_BRIDGE_URL?.trim();
  const token = process.env.BURN_MODE_BRIDGE_TOKEN?.trim();

  if (!rawUrl || !token) {
    throw new BridgeClientError(
      "bridge_unconfigured",
      "Burn Mode's private Mac bridge is not configured. Set BURN_MODE_BRIDGE_URL and BURN_MODE_BRIDGE_TOKEN.",
      false,
    );
  }

  if (token.length > 4_096 || /[\r\n]/u.test(token)) {
    throw new BridgeClientError(
      "bridge_invalid_configuration",
      "Burn Mode's Mac bridge token configuration is invalid.",
      false,
    );
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(rawUrl);
  } catch {
    throw new BridgeClientError(
      "bridge_invalid_configuration",
      "BURN_MODE_BRIDGE_URL must be a valid HTTP or HTTPS URL.",
      false,
    );
  }

  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new BridgeClientError(
      "bridge_invalid_configuration",
      "BURN_MODE_BRIDGE_URL must be an HTTP or HTTPS base URL without credentials, query parameters, or a fragment.",
      false,
    );
  }

  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/u, "")}/`;
  return { baseUrl, token };
}

function buildUrl(
  baseUrl: URL,
  path: string,
  query: Record<string, QueryValue> | undefined,
): URL {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new BridgeClientError(
      "bridge_invalid_request",
      "The Mac bridge request path is invalid.",
      false,
    );
  }

  const url = new URL(path.slice(1), baseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function errorForStatus(status: number): BridgeClientError {
  if (status === 400 || status === 422) {
    return new BridgeClientError(
      "bridge_invalid_request",
      "The Mac bridge rejected the request as invalid.",
      false,
    );
  }
  if (status === 401) {
    return new BridgeClientError(
      "bridge_unauthorized",
      "The Mac bridge rejected authorization. Check BURN_MODE_BRIDGE_TOKEN.",
      false,
    );
  }
  if (status === 403) {
    return new BridgeClientError(
      "bridge_forbidden",
      "The Mac bridge does not permit this operation.",
      false,
    );
  }
  if (status === 404) {
    return new BridgeClientError(
      "bridge_api_mismatch",
      "The configured Mac bridge does not support this endpoint.",
      false,
    );
  }
  if (status === 409) {
    return new BridgeClientError(
      "bridge_conflict",
      "The Mac bridge could not apply the operation because its current state changed.",
      false,
    );
  }
  if (status === 429) {
    return new BridgeClientError(
      "bridge_busy",
      "The Mac bridge is busy. Try again shortly.",
      true,
    );
  }
  if (status >= 500) {
    return new BridgeClientError(
      "bridge_unavailable",
      "The Mac bridge is temporarily unavailable.",
      true,
    );
  }
  return new BridgeClientError(
    "bridge_rejected",
    "The Mac bridge rejected the operation.",
    false,
  );
}

function transportError(
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): BridgeClientError {
  if (callerSignal?.aborted) {
    return new BridgeClientError(
      "bridge_cancelled",
      "The Mac bridge request was cancelled.",
      false,
    );
  }
  if (timeoutSignal.aborted) {
    return new BridgeClientError(
      "bridge_timeout",
      "The Mac bridge did not respond within 10 seconds.",
      true,
    );
  }
  return new BridgeClientError(
    "bridge_unreachable",
    "Burn Mode could not reach the private Mac bridge.",
    true,
  );
}

export async function requestBridge<TSchema extends z.ZodType>(
  options: BridgeRequest<TSchema>,
): Promise<z.output<TSchema>> {
  const { baseUrl, token } = readConfiguration();
  const url = buildUrl(baseUrl, options.path, options.query);
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutSignal])
    : timeoutSignal;
  const method = options.method ?? "GET";
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  });

  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    throw transportError(options.abortSignal, timeoutSignal);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw errorForStatus(response.status);
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_CHARACTERS) {
    await response.body?.cancel().catch(() => undefined);
    throw new BridgeClientError(
      "bridge_invalid_response",
      "The Mac bridge returned more data than Burn Mode can safely process.",
      false,
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw transportError(options.abortSignal, timeoutSignal);
  }

  if (!text || text.length > MAX_RESPONSE_CHARACTERS) {
    throw new BridgeClientError(
      "bridge_invalid_response",
      "The Mac bridge returned an empty or oversized response.",
      false,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new BridgeClientError(
      "bridge_invalid_response",
      "The Mac bridge returned invalid JSON.",
      false,
    );
  }

  const parsed = options.responseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new BridgeClientError(
      "bridge_invalid_response",
      "The Mac bridge response did not match the expected shape.",
      false,
    );
  }

  return parsed.data;
}

export function toBridgeToolError(error: unknown): BridgeToolError {
  if (error instanceof BridgeClientError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  return {
    code: "bridge_error",
    message: "Burn Mode could not complete the Mac bridge operation safely.",
    retryable: false,
  };
}
