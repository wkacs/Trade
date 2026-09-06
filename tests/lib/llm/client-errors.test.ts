import { describe, it, expect } from "vitest";
import { classifyLlmError, DEFAULT_LLM_TIMEOUT_MS } from "@/lib/llm/client";

/**
 * A hibaosztályozás nem kozmetika: a döntés-naplóban ez a szöveg magyarázza, miért
 * lett HOLD. Ha egy időtúllépés „network"-ként jelenik meg, rossz irányba indul a
 * hibakeresés — pontosan ez történt 2026-09-06-án.
 */
describe("classifyLlmError", () => {
  it("az OpenAI SDK időtúllépését időtúllépésnek nevezi", () => {
    // Az SDK üzenete „Request timed out.” — a régi /timeout/ regex ezt NEM fogta meg.
    expect(classifyLlmError("Request timed out.")).toBe("timeout");
    expect(classifyLlmError("APIConnectionTimeoutError: Request timed out")).toBe("timeout");
    expect(classifyLlmError("The operation was aborted")).toBe("timeout");
  });

  it("a szolgáltatói forgalomkorlátot külön kódnak jelöli", () => {
    expect(classifyLlmError("429 该模型当前访问量过大，请您稍后再试")).toBe("rate_limited");
    expect(classifyLlmError("Rate limit reached")).toBe("rate_limited");
  });

  it("minden más hálózati hiba", () => {
    expect(classifyLlmError("Connection error.")).toBe("network");
  });
});

describe("LLM időkorlát", () => {
  it("elég tág a mért 30-53 s-os GLM válaszidőhöz", () => {
    // 2026-09-06 mérés (prod kulcs, ~12k token): 53.2 s, 429, 29.9 s.
    // A régi 30 s-os korlát a hívások többségét levágta, és minden tick HOLD lett.
    expect(DEFAULT_LLM_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});
