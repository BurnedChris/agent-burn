import assert from "node:assert/strict";
import test from "node:test";

import calendar from "../agent/tools/calendar";
import healthLog from "../agent/tools/health_log";
import reminders from "../agent/tools/reminders";
import {
  ConnectSendblueAdapter,
  encodeSendblueThreadId,
} from "../agent/lib/connect-sendblue-adapter";

function toolInputSchema(tool: { inputSchema: unknown }): Record<string, unknown> {
  const schema = tool.inputSchema;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error("Expected a plain JSON Schema object.");
  }
  return schema as Record<string, unknown>;
}

test("custom tool input schemas have an object root for AI Gateway", () => {
  for (const [name, tool] of [
    ["calendar", calendar],
    ["health_log", healthLog],
    ["reminders", reminders],
  ] as const) {
    assert.equal(
      toolInputSchema(tool).type,
      "object",
      `${name} must expose input_schema.type = object`,
    );
  }
});

test("Sendblue can deliver from a durable callback without webhook initialization", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnvironment = {
    BURN_MODE_PHONE_NUMBER: process.env.BURN_MODE_PHONE_NUMBER,
    SENDBLUE_API_KEY: process.env.SENDBLUE_API_KEY,
    SENDBLUE_API_SECRET: process.env.SENDBLUE_API_SECRET,
    SENDBLUE_CONNECTOR_UID: process.env.SENDBLUE_CONNECTOR_UID,
    SENDBLUE_FROM_NUMBER: process.env.SENDBLUE_FROM_NUMBER,
    SENDBLUE_WEBHOOK_SECRET: process.env.SENDBLUE_WEBHOOK_SECRET,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };

  Object.assign(process.env, {
    BURN_MODE_PHONE_NUMBER: "+15555550123",
    SENDBLUE_API_KEY: "test-key",
    SENDBLUE_API_SECRET: "test-secret",
    SENDBLUE_FROM_NUMBER: "+15555550124",
    SENDBLUE_WEBHOOK_SECRET: "test-webhook-secret",
  });
  delete process.env.SENDBLUE_CONNECTOR_UID;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;

  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return Response.json({ message_handle: "test-outbound-message" });
  };

  try {
    const adapter = new ConnectSendblueAdapter();
    const threadId = encodeSendblueThreadId({
      contactNumber: "+15555550123",
      fromNumber: "+15555550124",
    });

    const result = await adapter.postMessage(threadId, "Burn Mode test");

    assert.equal(result.id, "test-outbound-message");
    assert.equal(providerCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
