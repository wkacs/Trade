import OpenAI from "openai";

/**
 * GLM (Zhipu AI) kliens OpenAI-compatible endpointon.
 * Lásd spec §3.2 + GLM-5.2 docs. Provider cserélhető, ha a BASE_URL-t átírod.
 */
export function createLlm(modelOverride?: string) {
  const client = new OpenAI({
    apiKey: process.env.LLM_API_KEY ?? "missing",
    baseURL: process.env.LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
  });
  return {
    client,
    model: modelOverride ?? "glm-4-flash",
  };
}

/** Az LLM-hívás mérhető adatai (T16): mennyi ideig tartott és mennyibe került. */
export interface LlmUsage {
  model: string;
  /** A prompt verziója — a régi naplók így visszavezethetők a pontos utasításra. */
  promptVersion: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** Igaz, ha időtúllépés vagy hálózati hiba miatt esett vissza a fallbackre. */
  failed: boolean;
  errorCode?: "timeout" | "rate_limited" | "network" | "bad_response";
  errorMessage?: string;
}

export interface ChatJsonOptions {
  /** Időkorlát ms-ban. A döntési út nem várhat korlátlanul egy LLM-re. */
  timeoutMs?: number;
  /**
   * Hány újrapróbálkozást engedünk az SDK-nak. A tick teljes kerete 300 s, ezért ez
   * NEM lehet korlátlan: a hívó szabja meg, mennyi fér bele a saját szakaszába.
   */
  maxRetries?: number;
  promptVersion?: string;
  temperature?: number;
}

/**
 * Alapértelmezett LLM-időkorlát.
 *
 * 2026-09-06 mérés a prod kulccsal, éles méretű (~12k token) prompttal:
 * 53.2 s · 429 (forgalomkorlát) · 29.9 s. A korábbi 30 s-os korlát ezért a hívások
 * többségét levágta: minden tick „LLM hiba, HOLD" lett, és a bot érdemben nem döntött.
 * A tick teljes kerete 300 s (route maxDuration), ebbe két fázis fér bele.
 */
export const DEFAULT_LLM_TIMEOUT_MS = 75_000;

/** Alapértelmezett újrapróbálkozás: egy ismétlés belefér, a végtelen nem. */
export const DEFAULT_LLM_MAX_RETRIES = 1;

/**
 * Hibaüzenet → hibakód. Tiszta függvény, mert a döntés-naplóban ez magyarázza a HOLD-ot.
 *
 * FONTOS: az OpenAI SDK időtúllépése „Request timed out.” — szóközzel. A régi
 * /timeout|abort/ minta ezt nem fogta meg, ezért minden időtúllépés „network"-ként
 * jelent meg, és rossz irányba vitte a hibakeresést.
 */
export function classifyLlmError(message: string): "timeout" | "rate_limited" | "network" {
  if (/429|rate.?limit|访问量过大/i.test(message)) return "rate_limited";
  if (/timed\s*out|timeout|abort/i.test(message)) return "timeout";
  return "network";
}

/**
 * Strukturált JSON kimenet kérése a modelltől. Ha a modell nem ad érvényes JSON-t, vagy
 * időtúllépés van, a fallback értékkel tér vissza (a hívó felel a HOLD-ra esésért).
 * A `usage` MINDIG kitöltött, hogy a költség és a késleltetés naplózható legyen.
 */
export async function chatJson<T>(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  fallback: T,
  options: ChatJsonOptions = {},
): Promise<{ data: T; raw: string; usage: LlmUsage }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_LLM_MAX_RETRIES;
  const promptVersion = options.promptVersion ?? "unversioned";
  const { client } = createLlm(model);
  const started = Date.now();

  const usage: LlmUsage = {
    model,
    promptVersion,
    latencyMs: 0,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    failed: false,
  };

  try {
    const completion = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        // GLM támogatja a JSON módot — struktúrát kényszerít
        response_format: { type: "json_object" } as never,
        temperature: options.temperature ?? 0.3,
      },
      { timeout: timeoutMs, maxRetries },
    );
    usage.latencyMs = Date.now() - started;
    usage.promptTokens = completion.usage?.prompt_tokens ?? null;
    usage.completionTokens = completion.usage?.completion_tokens ?? null;
    usage.totalTokens = completion.usage?.total_tokens ?? null;

    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = safeParse(raw, null as T | null);
    if (parsed === null) {
      usage.failed = true;
      usage.errorCode = "bad_response";
      usage.errorMessage = "A válasz nem értelmezhető JSON.";
      return { data: fallback, raw, usage };
    }
    return { data: parsed, raw, usage };
  } catch (e) {
    usage.latencyMs = Date.now() - started;
    usage.failed = true;
    const message = e instanceof Error ? e.message : String(e);
    usage.errorCode = classifyLlmError(message);
    usage.errorMessage = message;
    console.error("[LLM] hiba, fallback:", message);
    return { data: fallback, raw: "", usage };
  }
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Próbáljuk meg a legelső { ... } blokkot
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as T;
      } catch {}
    }
    return fallback;
  }
}
