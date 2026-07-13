import { z } from "zod";

/**
 * Anthropic requires every tool input_schema to declare an object at its root.
 * Zod unions preserve the useful oneOf branches but omit that root type, so
 * materialize the JSON Schema and add the provider-required object marker.
 */
export function toObjectToolSchema(schema: z.ZodType) {
  const { $schema: _schema, ...jsonSchema } = z.toJSONSchema(schema, {
    target: "draft-7",
  });

  return {
    ...jsonSchema,
    type: "object" as const,
  };
}
