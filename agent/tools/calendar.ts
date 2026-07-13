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
const eventIdSchema = z.string().trim().min(1).max(200);
const titleSchema = z.string().trim().min(1).max(160);
const calendarNameSchema = z.string().trim().min(1).max(80);

const runtimeInputSchema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("list"),
      from: isoDateTimeSchema,
      to: isoDateTimeSchema,
      calendar: calendarNameSchema.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    z.object({
      action: z.literal("create"),
      title: titleSchema,
      start: isoDateTimeSchema,
      end: isoDateTimeSchema,
      calendar: calendarNameSchema.optional(),
      notes: z.string().trim().min(1).max(500).optional(),
    }),
  ])
  .superRefine((input, ctx) => {
    const start = input.action === "list" ? input.from : input.start;
    const end = input.action === "list" ? input.to : input.end;
    if (Date.parse(start) >= Date.parse(end)) {
      ctx.addIssue({
        code: "custom",
        message:
          input.action === "list"
            ? "from must be before to."
            : "start must be before end.",
        path: [input.action === "list" ? "to" : "end"],
      });
    }
  });
const inputSchema = toObjectToolSchema(runtimeInputSchema);

const bridgeCalendarBlockSchema = z.object({
  id: eventIdSchema,
  title: titleSchema,
  start: isoDateTimeSchema,
  end: isoDateTimeSchema,
  calendar: calendarNameSchema.nullable().optional(),
});

const calendarBlockSchema = z.object({
  id: eventIdSchema,
  title: titleSchema,
  start: isoDateTimeSchema,
  end: isoDateTimeSchema,
  calendar: calendarNameSchema.nullable(),
});

const blockResponseSchema = z.object({ block: bridgeCalendarBlockSchema });
const blockListResponseSchema = z.object({
  blocks: z.array(bridgeCalendarBlockSchema).max(50),
});

const outputSchema = z.union([
  z.object({
    ok: z.literal(true),
    action: z.literal("list"),
    blocks: z.array(calendarBlockSchema).max(50),
    count: z.number().int().min(0).max(50),
  }),
  z.object({
    ok: z.literal(true),
    action: z.literal("create"),
    block: calendarBlockSchema,
  }),
  z.object({
    ok: z.literal(false),
    action: z.enum(["list", "create"]),
    error: bridgeToolErrorSchema,
  }),
]);

type BridgeCalendarBlock = z.infer<typeof bridgeCalendarBlockSchema>;

function minimizeBlock(block: BridgeCalendarBlock) {
  return {
    id: block.id,
    title: block.title,
    start: block.start,
    end: block.end,
    calendar: block.calendar ?? null,
  };
}

export default defineTool({
  description:
    "List calendar blocks or create a private focus/routine block through Christopher's Mac bridge. For action=list provide from and to. For action=create provide title, start, and end. Creation never adds attendees or sends invitations. This tool cannot delete events.",
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
          path: "/v1/calendar/blocks",
          query: {
            from: input.from,
            to: input.to,
            calendar: input.calendar,
            limit: input.limit,
          },
          responseSchema: blockListResponseSchema,
          abortSignal: ctx.abortSignal,
        });
        const blocks = result.blocks.map(minimizeBlock);
        return {
          ok: true as const,
          action: "list" as const,
          blocks,
          count: blocks.length,
        };
      }

      const result = await requestBridge({
        path: "/v1/calendar/blocks",
        method: "POST",
        body: {
          title: input.title,
          start: input.start,
          end: input.end,
          calendar: input.calendar,
          notes: input.notes,
          attendees: [],
        },
        responseSchema: blockResponseSchema,
        abortSignal: ctx.abortSignal,
        idempotencyKey: ctx.callId,
      });
      return {
        ok: true as const,
        action: "create" as const,
        block: minimizeBlock(result.block),
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
