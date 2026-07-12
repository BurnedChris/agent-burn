import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  bridgeToolErrorSchema,
  requestBridge,
  toBridgeToolError,
} from "../lib/bridge-client";

const isoDateTimeSchema = z
  .string()
  .trim()
  .max(40)
  .datetime({ offset: true });
const logIdSchema = z.string().trim().min(1).max(200);
const healthKindSchema = z.enum([
  "hydration",
  "exercise",
  "sleep",
  "energy",
  "mood",
  "caffeine",
  "meal",
  "medication",
  "other",
]);
const noteSchema = z.string().trim().min(1).max(500);
const unitSchema = z.string().trim().min(1).max(32);
const valueSchema = z.number().finite().min(-1_000_000).max(1_000_000);

const inputSchema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("append"),
      kind: healthKindSchema,
      recordedAt: isoDateTimeSchema.optional(),
      value: valueSchema.optional(),
      unit: unitSchema.optional(),
      note: noteSchema.optional(),
    }),
    z.object({
      action: z.literal("list"),
      kind: healthKindSchema.optional(),
      from: isoDateTimeSchema.optional(),
      to: isoDateTimeSchema.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
  ])
  .superRefine((input, ctx) => {
    if (input.action === "append") {
      if (input.value === undefined && input.note === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "Provide a value or a short factual note.",
          path: ["value"],
        });
      }
      if (input.unit !== undefined && input.value === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "A unit can only be used with a value.",
          path: ["unit"],
        });
      }
    }
    if (
      input.action === "list" &&
      input.from &&
      input.to &&
      Date.parse(input.from) > Date.parse(input.to)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "from must be before or equal to to.",
        path: ["to"],
      });
    }
  });

const bridgeHealthLogSchema = z.object({
  id: logIdSchema,
  kind: healthKindSchema,
  recordedAt: isoDateTimeSchema,
  value: valueSchema.nullable().optional(),
  unit: unitSchema.nullable().optional(),
  note: noteSchema.nullable().optional(),
});

const healthLogSchema = z.object({
  id: logIdSchema,
  kind: healthKindSchema,
  recordedAt: isoDateTimeSchema,
  value: valueSchema.nullable(),
  unit: unitSchema.nullable(),
  note: noteSchema.nullable(),
});

const appendResponseSchema = z.object({ log: bridgeHealthLogSchema });
const listResponseSchema = z.object({
  logs: z.array(bridgeHealthLogSchema).max(50),
});

const outputSchema = z.union([
  z.object({
    ok: z.literal(true),
    action: z.literal("append"),
    log: healthLogSchema,
  }),
  z.object({
    ok: z.literal(true),
    action: z.literal("list"),
    logs: z.array(healthLogSchema).max(50),
    count: z.number().int().min(0).max(50),
  }),
  z.object({
    ok: z.literal(false),
    action: z.enum(["append", "list"]),
    error: bridgeToolErrorSchema,
  }),
]);

type BridgeHealthLog = z.infer<typeof bridgeHealthLogSchema>;

function minimizeLog(log: BridgeHealthLog) {
  return {
    id: log.id,
    kind: log.kind,
    recordedAt: log.recordedAt,
    value: log.value ?? null,
    unit: log.unit ?? null,
    note: log.note ?? null,
  };
}

export default defineTool({
  description:
    "Append or list Christopher's self-reported routine and health observations through the private Mac bridge. Record facts only; never diagnose, infer a condition, or recommend treatment.",
  inputSchema,
  outputSchema,
  approval: ({ toolInput }) =>
    toolInput?.action === "list" ? "not-applicable" : "user-approval",
  async execute(input, ctx) {
    try {
      if (input.action === "list") {
        const result = await requestBridge({
          path: "/v1/health-logs",
          query: {
            kind: input.kind,
            from: input.from,
            to: input.to,
            limit: input.limit,
          },
          responseSchema: listResponseSchema,
          abortSignal: ctx.abortSignal,
        });
        const logs = result.logs.map(minimizeLog);
        return {
          ok: true as const,
          action: "list" as const,
          logs,
          count: logs.length,
        };
      }

      const result = await requestBridge({
        path: "/v1/health-logs",
        method: "POST",
        body: {
          kind: input.kind,
          recordedAt: input.recordedAt,
          value: input.value,
          unit: input.unit,
          note: input.note,
        },
        responseSchema: appendResponseSchema,
        abortSignal: ctx.abortSignal,
        idempotencyKey: ctx.callId,
      });
      return {
        ok: true as const,
        action: "append" as const,
        log: minimizeLog(result.log),
      };
    } catch (error) {
      return {
        ok: false as const,
        action: input.action,
        error: toBridgeToolError(error),
      };
    }
  },
});
