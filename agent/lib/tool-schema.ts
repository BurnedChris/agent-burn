import { z } from "zod";

/**
 * AI Gateway requires every tool input_schema to be an object and rejects
 * union combinators at the root. Flatten discriminated-union branches for the
 * provider while retaining the original Zod schema for runtime validation.
 */
export function toObjectToolSchema(schema: z.ZodType) {
  const {
    $schema: _schema,
    allOf,
    anyOf,
    oneOf,
    ...jsonSchema
  } = z.toJSONSchema(schema, {
    target: "draft-7",
  });

  if (
    (Array.isArray(allOf) && allOf.length > 0) ||
    (Array.isArray(anyOf) && anyOf.length > 0)
  ) {
    throw new Error(
      "Tool input schemas may not use top-level allOf or anyOf combinators.",
    );
  }

  if (!Array.isArray(oneOf) || oneOf.length === 0) {
    return {
      ...jsonSchema,
      type: "object" as const,
    };
  }

  const properties: Record<string, unknown> = {};
  const actions: string[] = [];

  for (const branch of oneOf) {
    if (
      typeof branch !== "object" ||
      branch === null ||
      Array.isArray(branch) ||
      typeof branch.properties !== "object" ||
      branch.properties === null ||
      Array.isArray(branch.properties)
    ) {
      throw new Error("Expected object branches in tool input schema.");
    }

    for (const [name, property] of Object.entries(branch.properties)) {
      if (name === "action") {
        if (
          typeof property !== "object" ||
          property === null ||
          Array.isArray(property) ||
          typeof property.const !== "string"
        ) {
          throw new Error("Expected a string action discriminator.");
        }
        actions.push(property.const);
        continue;
      }

      const existing = properties[name];
      if (
        existing !== undefined &&
        JSON.stringify(existing) !== JSON.stringify(property)
      ) {
        throw new Error(`Tool property ${name} differs between action branches.`);
      }
      properties[name] = property;
    }
  }

  properties.action = {
    type: "string",
    enum: actions,
    description: "Operation to perform. Supply the fields required by that action.",
  };

  return {
    ...jsonSchema,
    type: "object" as const,
    properties,
    required: ["action"],
    additionalProperties: false,
  };
}
