import { getToken } from "@vercel/connect";
import { z } from "zod";

const e164Schema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/u, "Expected an E.164 phone number.");

const sendblueWebhookConfigSchema = z.object({
  defaultFromNumber: e164Schema,
  allowedContactNumber: e164Schema,
  webhookSecret: z
    .string()
    .min(16)
    .max(4_096)
    .refine((value) => value.trim() === value, "Secret cannot have surrounding whitespace."),
});

const sendblueCredentialsSchema = sendblueWebhookConfigSchema.extend({
  apiKey: z.string().trim().min(1).max(4_096),
  apiSecret: z
    .string()
    .min(1)
    .max(4_096)
    .refine(
      (value) => value.trim() === value,
      "Secret cannot have surrounding whitespace.",
    ),
});

export type SendblueWebhookConfig = z.infer<
  typeof sendblueWebhookConfigSchema
>;
export type SendblueCredentials = z.infer<typeof sendblueCredentialsSchema>;

/** Resolve the fields needed to authenticate and filter a webhook locally. */
export function resolveSendblueWebhookConfig(): SendblueWebhookConfig {
  const parsed = sendblueWebhookConfigSchema.safeParse({
    defaultFromNumber: process.env.SENDBLUE_FROM_NUMBER,
    allowedContactNumber: process.env.BURN_MODE_PHONE_NUMBER,
    webhookSecret: process.env.SENDBLUE_WEBHOOK_SECRET,
  });

  if (!parsed.success) {
    throw new Error(
      "Sendblue webhook security is not configured. Set SENDBLUE_FROM_NUMBER, BURN_MODE_PHONE_NUMBER, and SENDBLUE_WEBHOOK_SECRET.",
    );
  }

  return parsed.data;
}

/**
 * Resolve Sendblue's API secret from an app-scoped Vercel Connect API-key
 * connector. The documented direct environment variable remains available
 * for local development where Vercel OIDC is not configured.
 */
export async function resolveSendblueCredentials(): Promise<SendblueCredentials> {
  const connectorUid = process.env.SENDBLUE_CONNECTOR_UID?.trim();
  const isHostedVercel =
    process.env.VERCEL === "1" && process.env.VERCEL_ENV !== "development";

  if (isHostedVercel && !connectorUid) {
    throw new Error(
      "SENDBLUE_CONNECTOR_UID is required on hosted Vercel environments.",
    );
  }

  let apiSecret: string | undefined;

  if (connectorUid) {
    try {
      apiSecret = await getToken(connectorUid, {
        subject: { type: "app" },
      });
    } catch (cause) {
      throw new Error(
        "Could not resolve the Sendblue API secret from Vercel Connect.",
        { cause },
      );
    }
  } else {
    apiSecret = process.env.SENDBLUE_API_SECRET;
  }

  const parsed = sendblueCredentialsSchema.safeParse({
    ...resolveSendblueWebhookConfig(),
    apiKey: process.env.SENDBLUE_API_KEY,
    apiSecret,
  });

  if (!parsed.success) {
    throw new Error(
      "Sendblue is not configured. Set SENDBLUE_CONNECTOR_UID (or local SENDBLUE_API_SECRET), SENDBLUE_API_KEY, SENDBLUE_FROM_NUMBER, and SENDBLUE_WEBHOOK_SECRET.",
    );
  }

  return parsed.data;
}
