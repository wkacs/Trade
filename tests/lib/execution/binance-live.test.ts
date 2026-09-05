import { describe, expect, it, vi } from "vitest";
import { BinanceLiveClient } from "@/lib/execution/binance-live";

describe("BinanceLiveClient protection lifecycle", () => {
  it("replace esetén előbb töröl, majd új STOP_LOSS_LIMIT ordert ad fel", async () => {
    const client = new BinanceLiveClient("key", "secret");
    const del = vi.spyOn(client, "signedDelete").mockResolvedValue({ status: "CANCELED" });
    const post = vi.spyOn(client, "signedPost").mockResolvedValue({ orderId: 99 });
    const action = { kind: "replace" as const, symbol: "BTC", cancelOrderId: "7", qty: "0.01", stopPrice: "57000", limitPrice: "56943", reason: "ratchet" };
    const out = await client.executeProtection([action]);
    expect(del).toHaveBeenCalledWith("/api/v3/order", { symbol: "BTCUSDT", orderId: "7" });
    expect(post).toHaveBeenCalledWith("/api/v3/order", expect.objectContaining({ type: "STOP_LOSS_LIMIT", quantity: "0.01" }));
    expect(out[0]).toMatchObject({ ok: true, newOrderId: "99" });
  });

  it("csere közbeni fill után nem próbál új védőordert feladni", async () => {
    const client = new BinanceLiveClient("key", "secret");
    vi.spyOn(client, "signedDelete").mockResolvedValue({ status: "FILLED" });
    const post = vi.spyOn(client, "signedPost");
    const out = await client.executeProtection([{ kind: "replace", symbol: "ETH", cancelOrderId: "8", qty: "1", stopPrice: "100", limitPrice: "99", reason: "qty" }]);
    expect(post).not.toHaveBeenCalled();
    expect(out[0].filledDuringReplace).toBe(true);
  });

  it("exit előtti cancel során már teljesült stopot külön jelzi", async () => {
    const client = new BinanceLiveClient("key", "secret");
    vi.spyOn(client, "signedDelete").mockResolvedValue({ status: "FILLED" });
    const action = { kind: "cancel" as const, symbol: "SOL", cancelOrderId: "9", reason: "exit" };
    const out = await client.executeProtection([action]);
    expect(out[0]).toMatchObject({ ok: true, filledDuringReplace: true });
  });
});
