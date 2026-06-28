import { describe, it, expect } from "vitest";
import { schema } from "@/db/client";

describe("schema — folyamat-napló", () => {
  it("van tickRuns tábla", () => {
    expect(schema.tickRuns).toBeDefined();
  });
  it("a trades táblának van origin oszlopa", () => {
    expect(schema.trades.origin).toBeDefined();
  });
});
