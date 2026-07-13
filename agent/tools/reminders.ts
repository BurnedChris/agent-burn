import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  bridgeToolErrorSchema,
  requestBridge,
  toBridgeToolError,
} from "../lib/bridge-client";
import { toObjectToolSchema } from "../lib/tool-schema";

const isoDateTimeSchema = z
  .string()
  .trim()
  .max(40)
  .datetime({ offset: true });
const reminderIdSchema = z.string().trim().min(1).max(200);
const titleSchema = z.string().trim().min(1).max(160);
const listNameSchema = z.string().trim().min(1).max(80);

const runtimeInputSchema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("list"),
      status: z.enum(["open", "completed", "all"]).default("open"),
      dueAfter: isoDateTimeSchema.optional(),
      dueBefore: isoDateTimeSchema.optional(),
      list: listNameSchema.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    z.object({
      action: z.literal("create"),
      title: titleSchema,
      dueAt: isoDateTimeSchema.optional(),
      notes: z.string().trim().min(1).max(500).optional(),
      list: listNameSchema.optional(),
    }),
    z.object({
      action: z.literal("complete"),
      id: reminderIdSchema,
    }),
  ])
  .superRefine((input, ctx) => {
    if (
      input.action === "list" &&
      input.dueAfter &&
      input.dueBefore &&
      Date.parse(input.dueAfter) > Date.parse(input.dueBefore)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "dueAfter must be before or equal to dueBefore.",
        path: ["dueBefore"],
      });
    }
  });
const inputSchema = toObjectToolSchema(runtimeInputSchema);

const bridgeReminderSchema = z.object({
  id: reminderIdSchema,
  title: titleSchema,
  completed: z.boolean(),
  dueAt: isoDateTimeSchema.nullable().optional(),
  list: listNameSchema.nullable().optional(),
});

const reminderSchema = z.object({
  id: reminderIdSchema,
  title: titleSchema,
  completed: z.boolean(),
  dueAt: isoDateTimeSchema.nullable(),
  list: listNameSchema.nullable(),
});

const reminderResponseSchema = z.object({ reminder: bridgeReminderSchema });
const reminderListResponseSchema = z.object({
  reminders: z.array(bridgeReminderSchema).max(50),
});

const outputSchema = z.union([
  z.object({
    ok: z.literal(true),
    action: z.literal("list"),
    reminders: z.array(reminderSchema).max(50),
    count: z.number().int().min(0).max(50),
  }),
  z.object({
    ok: z.literal(true),
    action: z.literal("create"),
    reminder: reminderSchema,
  }),
  z.object({
    ok: z.literal(true),
    action: z.literal("complete"),
    reminder: reminderSchema,
  }),
  z.object({
    ok: z.literal(false),
    action: z.enum(["list", "create", "complete"]),
    error: bridgeToolErrorSchema,
  }),
]);

type BridgeReminder = z.infer<typeof bridgeReminderSchema>;

function minimizeReminder(reminder: BridgeReminder) {
  return {
    id: reminder.id,
    title: reminder.title,
    completed: reminder.completed,
    dueAt: reminder.dueAt ?? null,
    list: reminder.list ?? null,
  };
}

export default defineTool({
  description:
    "List, create, or complete Christopher's reminders through the private Mac bridge. Prefer a clear short title. This tool never deletes reminders.",
  inputSchema,
  outputSchema,
  approval: ({ toolInput }) => {
    const parsed = runtimeInputSchema.safeParse(toolInput);
    return parsed.success && parsed.data.action === "list"
      ? "not-applicable"
      : "user-approval";
  },
  async execute(rawInput, ctx) {
    const input = runtimeInputSchema.parse(rawInput);
    try {
      if (input.action === "list") {
        const result = await requestBridge({
          path: "/v1/reminders",
          query: {
            status: input.status,
            dueAfter: input.dueAfter,
            dueBefore: input.dueBefore,
            list: input.list,
            limit: input.limit,
          },
          responseSchema: reminderListResponseSchema,
          abortSignal: ctx.abortSignal,
        });
        const reminders = result.reminders.map(minimizeReminder);
        return {
          ok: true as const,
          action: "list" as const,
          reminders,
          count: reminders.length,
        };
      }

      if (input.action === "create") {
        const result = await requestBridge({
          path: "/v1/reminders",
          method: "POST",
          body: {
            title: input.title,
            dueAt: input.dueAt,
            notes: input.notes,
            list: input.list,
          },
          responseSchema: reminderResponseSchema,
          abortSignal: ctx.abortSignal,
          idempotencyKey: ctx.callId,
        });
        return {
          ok: true as const,
          action: "create" as const,
          reminder: minimizeReminder(result.reminder),
        };
      }

      const result = await requestBridge({
        path: `/v1/reminders/${encodeURIComponent(input.id)}/complete`,
        method: "POST",
        body: {},
        responseSchema: reminderResponseSchema,
        abortSignal: ctx.abortSignal,
        idempotencyKey: ctx.callId,
      });
      return {
        ok: true as const,
        action: "complete" as const,
        reminder: minimizeReminder(result.reminder),
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
