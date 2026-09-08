import { describe, it, expect } from "vitest";
import {
  nextCryptoTickMs,
  nextStockCycleMs,
  nextCycleState,
  formatCountdown,
  stockSessionInfo,
} from "@/components/NextCycle";

describe("nextCryptoTickMs – óránkénti tick a :07 percnél", () => {
  it("a perc előtt még az AKTUÁLIS órát adja", () => {
    expect(nextCryptoTickMs(Date.parse("2026-02-02T10:03:00Z"))).toBe(
      Date.parse("2026-02-02T10:07:00Z"),
    );
  });

  it("a perc után a KÖVETKEZŐ órát", () => {
    expect(nextCryptoTickMs(Date.parse("2026-02-02T10:07:30Z"))).toBe(
      Date.parse("2026-02-02T11:07:00Z"),
    );
  });

  it("napváltáskor is helyes", () => {
    expect(nextCryptoTickMs(Date.parse("2026-02-02T23:59:00Z"))).toBe(
      Date.parse("2026-02-03T00:07:00Z"),
    );
  });
});

describe("nextStockCycleMs – 5 perces rács az ülés alatt", () => {
  it("ülés közben a következő 5 perces rács-pont", () => {
    const { at, dormant } = nextStockCycleMs(Date.parse("2026-02-02T16:02:10Z"));
    expect(at).toBe(Date.parse("2026-02-02T16:05:00Z"));
    expect(dormant).toBe(false);
  });

  it("zárt piacon a következő NYITÁSIG számol, és alvó állapotot jelez", () => {
    const { at, dormant } = nextStockCycleMs(Date.parse("2026-02-02T22:00:00Z"));
    expect(at).toBe(Date.parse("2026-02-03T14:30:00Z"));
    expect(dormant).toBe(true);
  });
});

describe("nextCycleState – a felirat a ciklus jelentése", () => {
  it("a kriptó sáv órás döntést mond", () => {
    expect(nextCycleState("crypto", Date.parse("2026-02-02T10:00:00Z")).label).toBe(
      "óránkénti döntés",
    );
  });

  it("zárt piacon a részvény sáv a nyitásra hivatkozik", () => {
    const s = nextCycleState("stock", Date.parse("2026-02-02T22:00:00Z"));
    expect(s.label).toContain("piac zárva");
    expect(s.dormant).toBe(true);
  });
});

describe("formatCountdown", () => {
  it("egy órán belül pp:mm", () => {
    expect(formatCountdown(9 * 60 * 1000 + 5 * 1000)).toBe("09:05");
  });

  it("egy órán túl ó:pp:mm", () => {
    expect(formatCountdown(3 * 3600 * 1000 + 4 * 60 * 1000 + 9 * 1000)).toBe("3:04:09");
  });

  it("lejárt visszaszámláló nem megy negatívba", () => {
    expect(formatCountdown(-5000)).toBe("00:00");
  });
});

describe("stockSessionInfo – mikor zár, illetve mikor nyit", () => {
  it("nyitva: a következő határpont az AZNAPI zárás", () => {
    const info = stockSessionInfo(Date.parse("2026-02-02T16:00:00Z")); // hétfő 11:00 ET
    expect(info.open).toBe(true);
    expect(info.at).toBe(Date.parse("2026-02-02T21:00:00Z"));
    expect(info.chip.startsWith("zár")).toBe(true);
  });

  it("zárva: a következő határpont a KÖVETKEZŐ nyitás", () => {
    const info = stockSessionInfo(Date.parse("2026-02-02T22:30:00Z")); // hétfő 17:30 ET
    expect(info.open).toBe(false);
    expect(info.at).toBe(Date.parse("2026-02-03T14:30:00Z"));
    expect(info.chip.startsWith("nyit")).toBe(true);
  });

  it("hétvégén a hétfői nyitást célozza", () => {
    const info = stockSessionInfo(Date.parse("2026-02-07T12:00:00Z")); // szombat
    expect(info.open).toBe(false);
    expect(info.at).toBe(Date.parse("2026-02-09T14:30:00Z"));
  });

  it("más napra eső határpontnál a nap neve is szerepel", () => {
    const info = stockSessionInfo(Date.parse("2026-02-07T12:00:00Z"));
    // A hétfői nyitás nem ma van, ezért a címke nem csak órát mutat.
    expect(info.chip.split(" ").length).toBeGreaterThan(2);
  });

  it("fél napon a korábbi zárást mutatja", () => {
    const info = stockSessionInfo(Date.parse("2026-11-27T16:00:00Z")); // 11:00 ET, fél nap
    expect(info.at).toBe(Date.parse("2026-11-27T18:00:00Z"));
  });
});
