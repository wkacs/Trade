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
  errorCode?: "timeout" | "network" | "bad_response";
  errorMessage?: string;
}

export interface ChatJsonOptions {
  /** Időkorlát ms-ban. A döntési út nem várhat korlátlanul egy LLM-re. */
  timeoutMs?: number;
  promptVersion?: string;
  temperature?: number;
}

/** Alapértelmezett LLM-időkorlát: a tick nem akadhat meg egy lassú válaszon. */
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;

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
      { timeout: timeoutMs },
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
    usage.errorCode = /timeout|abort/i.test(message) ? "timeout" : "network";
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
