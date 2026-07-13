import { createHash } from "node:crypto";

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9:_-]/gu, "_");
}

function branchFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 16);
}

/** Stable across instances, isolated across Vercel projects and preview branches. */
export function deploymentNamespace(): string {
  const project = process.env.VERCEL_PROJECT_ID?.trim() || "local";
  const environment =
    process.env.VERCEL_TARGET_ENV?.trim() ||
    process.env.VERCEL_ENV?.trim() ||
    "local";
  const branch =
    environment === "preview"
      ? branchFingerprint(
          process.env.VERCEL_GIT_COMMIT_REF?.trim() || "preview",
        )
      : null;

  return [project, environment, branch]
    .filter((part): part is string => Boolean(part))
    .map(safe)
    .join(":");
}
