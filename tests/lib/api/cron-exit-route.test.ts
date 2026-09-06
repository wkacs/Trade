import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeScheduledExit: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));
vi.mock("@/lib/engine/run-scheduled-exit", () => ({
  executeScheduledExit: mocks.executeScheduledExit,
}));
vi.mock("@/lib/ops/cron-auth", () => ({
  authorizeCronRequest: () => ({ ok: true, mode: "secret" }),
}));

import { POST } from "@/app/api/cron/exit/route";

describe("cron exit route", () => {
  beforeEach(() => {
    mocks.executeScheduledExit.mockReset();
    mocks.waitUntil.mockReset();
  });

  it("a hosszabb kilépés befejezése előtt 202 választ ad", async () => {
    let finish!: (value: { ok: true; ran: true }) => void;
    const pending = new Promise<{ ok: true; ran: true }>((resolve) => { finish = resolve; });
    mocks.executeScheduledExit.mockReturnValue(pending);

    const responseOrTimeout = await Promise.race([
      POST(new Request("https://trade.example/api/cron/exit", { method: "POST" })),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    finish({ ok: true, ran: true });

    expect(responseOrTimeout).not.toBe("timeout");
    expect(responseOrTimeout).toBeInstanceOf(Response);
    const response = responseOrTimeout as Response;
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, accepted: true, cycle: "exit" });
    expect(mocks.waitUntil).toHaveBeenCalledOnce();
  });
});
