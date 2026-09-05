import { timingSafeEqual } from "node:crypto";

/**
 * The scheduled-tick endpoint can create orders.  A missing secret must therefore
 * never make a deployed endpoint public.  Local, unauthenticated calls are only
 * available through an explicit opt-in, so a copied production environment keeps
 * failing closed.
 */
export interface CronAuthEnvironment {
  CRON_SECRET?: string;
  ALLOW_UNAUTHENTICATED_LOCAL_CRON?: string;
  NODE_ENV?: string;
  VERCEL?: string;
}

export type CronAuthorization =
  | { ok: true; mode: "secret" | "explicit-local" }
  | { ok: false; status: 401 | 503; error: "unauthorized" | "cron_secret_not_configured" };

export function isHostedCronEnvironment(env: CronAuthEnvironment = process.env): boolean {
  return env.NODE_ENV === "production" || env.VERCEL === "1";
}

function constantTimeBearerMatch(value: string | null, secret: string): boolean {
  const prefix = "Bearer ";
  if (!value?.startsWith(prefix)) return false;
  const supplied = Buffer.from(value.slice(prefix.length));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/**
 * Authorizes a cron request without exposing the secret or accepting an implicit
 * development fallback.  A hosted deployment without CRON_SECRET receives 503:
 * that is a configuration failure, not an invitation to run the tick publicly.
 */
export function authorizeCronRequest(
  authorization: string | null,
  env: CronAuthEnvironment = process.env,
): CronAuthorization {
  const secret = env.CRON_SECRET?.trim();
  if (secret) {
    return constantTimeBearerMatch(authorization, secret)
      ? { ok: true, mode: "secret" }
      : { ok: false, status: 401, error: "unauthorized" };
  }

  const explicitLocal = env.ALLOW_UNAUTHENTICATED_LOCAL_CRON === "true";
  if (!isHostedCronEnvironment(env) && explicitLocal) {
    return { ok: true, mode: "explicit-local" };
  }
  return { ok: false, status: 503, error: "cron_secret_not_configured" };
}
