import { describe, expect, it } from "vitest";
import { authorizeCronRequest, isHostedCronEnvironment } from "@/lib/ops/cron-auth";

describe("cron tick authorization", () => {
  it("accepts only the configured bearer secret", () => {
    const env = { CRON_SECRET: "correct-secret", NODE_ENV: "production" };
    expect(authorizeCronRequest("Bearer correct-secret", env)).toEqual({ ok: true, mode: "secret" });
    expect(authorizeCronRequest("Bearer wrong-secret", env)).toEqual({
      ok: false,
      status: 401,
      error: "unauthorized",
    });
    expect(authorizeCronRequest(null, env)).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });

  it("fails closed in production or Vercel when the secret is absent", () => {
    expect(authorizeCronRequest(null, { NODE_ENV: "production" })).toEqual({
      ok: false,
      status: 503,
      error: "cron_secret_not_configured",
    });
    expect(authorizeCronRequest(null, { VERCEL: "1", ALLOW_UNAUTHENTICATED_LOCAL_CRON: "true" })).toEqual({
      ok: false,
      status: 503,
      error: "cron_secret_not_configured",
    });
  });

  it("permits an unauthenticated local request only through an explicit opt-in", () => {
    expect(authorizeCronRequest(null, { NODE_ENV: "development" })).toEqual({
      ok: false,
      status: 503,
      error: "cron_secret_not_configured",
    });
    expect(authorizeCronRequest(null, { NODE_ENV: "test", ALLOW_UNAUTHENTICATED_LOCAL_CRON: "true" })).toEqual({
      ok: true,
      mode: "explicit-local",
    });
  });

  it("recognizes both supported hosted-environment markers", () => {
    expect(isHostedCronEnvironment({ NODE_ENV: "production" })).toBe(true);
    expect(isHostedCronEnvironment({ VERCEL: "1" })).toBe(true);
    expect(isHostedCronEnvironment({ NODE_ENV: "development" })).toBe(false);
  });
});
