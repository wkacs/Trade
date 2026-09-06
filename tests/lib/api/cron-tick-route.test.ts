import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeScheduledTick: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));
vi.mock("@/lib/engine/run-scheduled-tick", () => ({
  executeScheduledTick: mocks.executeScheduledTick,
}));
vi.mock("@/lib/ops/cron-auth", () => ({
  authorizeCronRequest: () => ({ ok: true, mode: "secret" }),
}));

import { POST } from "@/app/api/cron/tick/route";

describe("cron tick route", () => {
  beforeEach(() => {
    mocks.executeScheduledTick.mockReset();
    mocks.waitUntil.mockReset();
  });

  it("acknowledges an authenticated trigger before the trading cycle finishes", async () => {
    let finishTick!: (value: { ok: true; tickId: string }) => void;
    const pendingTick = new Promise<{ ok: true; tickId: string }>((resolve) => {
      finishTick = resolve;
    });
    mocks.executeScheduledTick.mockReturnValue(pendingTick);

    const responseOrTimeout = await Promise.race([
      POST(new Request("https://trade.example/api/cron/tick", { method: "POST" })),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    finishTick({ ok: true, tickId: "2026-09-06-08" });

    expect(responseOrTimeout).not.toBe("timeout");
    expect(responseOrTimeout).toBeInstanceOf(Response);
    const response = responseOrTimeout as Response;
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, accepted: true });
    expect(mocks.waitUntil).toHaveBeenCalledOnce();
    expect(mocks.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });
});
