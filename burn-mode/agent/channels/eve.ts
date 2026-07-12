import { eveChannel } from "eve/channels/eve";
import {
  localDev,
  type AuthFn,
  vercelOidc,
  verifyHttpBasic,
} from "eve/channels/auth";

/**
 * Admit Christopher's private clients without baking a secret into the build.
 * When either credential is missing, this verifier skips and the auth walk
 * remains closed in production (apart from valid same-project Vercel OIDC).
 */
const privateBasicAuth: AuthFn<Request> = (request) => {
  const username = process.env.BURN_MODE_USERNAME;
  const password = process.env.BURN_MODE_PASSWORD;

  if (!username || !password) return null;

  const result = verifyHttpBasic(request.headers.get("authorization"), {
    username,
    password,
  });

  return result.ok ? result.sessionAuth : null;
};

export default eveChannel({
  auth: [
    // Trusted calls from this Vercel project.
    vercelOidc(),
    // Local development only; ignored on a real deployment.
    localDev(),
    // The Mac bridge, CLI, or a future private web client.
    privateBasicAuth,
  ],
});
