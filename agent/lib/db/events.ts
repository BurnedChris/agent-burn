import { getBurnModeDatabase } from "./client";
import {
  burnModeEvents,
  type BurnModeEventData,
} from "./schema";
import { deploymentNamespace } from "../deployment-namespace";

export interface BurnModeEventInput {
  correlationKey?: string;
  data?: BurnModeEventData;
  eventType: string;
  occurredAt?: Date;
  source: string;
}

export async function recordBurnModeEvent(
  input: BurnModeEventInput,
): Promise<void> {
  // The Chat SDK supports an in-memory local channel without a database.
  if (!process.env.DATABASE_URL?.trim()) return;

  const { database } = getBurnModeDatabase();
  await database.insert(burnModeEvents).values({
    correlationKey: input.correlationKey,
    data: input.data ?? {},
    environment: deploymentNamespace(),
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    source: input.source,
  });
}
