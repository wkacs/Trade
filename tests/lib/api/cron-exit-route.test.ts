import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeScheduledExit: vi.fn(),
  executeScheduledStockIntraday: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));
vi.mock("@/lib/engine/run-scheduled-exit", () => ({
  executeScheduledExit: mocks.executeScheduledExit,
}));
vi.mock("@/lib/engine/run-scheduled-stock-intraday", () => ({
  executeScheduledStockIntraday: mocks.executeScheduledStockIntraday,
}));
vi.mock("@/lib/ops/cron-auth", () => ({
  authorizeCronRequest: () => ({ ok: true, mode: "secret" }),
}));

import { POST } from "@/app/api/cron/exit/route";

const request = () => new Request("https://trade.example/api/cron/exit", { method: "POST" });

describe("cron exit route", () => {
  beforeEach(() => {
    mocks.executeScheduledExit.mockReset();
    mocks.executeScheduledStockIntraday.mockReset();
    mocks.waitUntil.mockReset();
    mocks.executeScheduledStockIntraday.mockResolvedValue({ ok: true, skipped: true, reason: "session:closed" });
  });

  it("a hosszabb kilépés befejezése előtt 202 választ ad", async () => {
    let finish!: (value: { ok: true; ran: true }) => void;
    const pending = new Promise<{ ok: true; ran: true }>((resolve) => {
      finish = resolve;
    });
    mocks.executeScheduledExit.mockReturnValue(pending);

    const responseOrTimeout = await Promise.race([
      POST(request()),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    finish({ ok: true, ran: true });

    expect(responseOrTimeout).not.toBe("timeout");
    expect(responseOrTimeout).toBeInstanceOf(Response);
    const response = responseOrTimeout as Response;
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      accepted: true,
      cycles: ["exit", "stock-intraday"],
    });
    expect(mocks.waitUntil).toHaveBeenCalledOnce();
  });

  it("MINDKÉT ciklust elindítja (a részvény day trading a kriptó kilépés mellett)", async () => {
    mocks.executeScheduledExit.mockResolvedValue({ ok: true, ran: true });
    await POST(request());
    expect(mocks.executeScheduledExit).toHaveBeenCalledOnce();
    expect(mocks.executeScheduledStockIntraday).toHaveBeenCalledOnce();
  });

  it("a részvény-ciklus kivétele NEM viszi el a választ és a kripto kilépést", async () => {
    mocks.executeScheduledExit.mockResolvedValue({ ok: true, ran: true });
    mocks.executeScheduledStockIntraday.mockRejectedValue(new Error("Yahoo 429"));

    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(mocks.executeScheduledExit).toHaveBeenCalledOnce();
    // A háttérben futó ciklusok befejeződése után sincs kezeletlen elutasítás.
    await Promise.resolve();
  });
});
