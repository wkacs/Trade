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
    model: modelOverride ?? "glm-4.7-flash",
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
  errorCode?: LlmErrorCode;
  errorMessage?: string;
}

/**
 * A döntés-naplóban ez a kód mondja meg, MIÉRT lett HOLD. Külön kód jár az
 * `auth` (rossz/lejárt kulcs vagy base-URL–kulcs eltérés), a `not_found`
 * (nem létező modellnév — pl. a leállított `glm-4-flash`) és a `bad_request`
 * (a szolgáltató elutasította a kérés alakját, pl. a JSON-módot) esetére,
 * mert ezek mást igényelnek, mint egy múló hálózati zavar.
 */
export type LlmErrorCode =
  | "timeout"
  | "rate_limited"
  | "auth"
  | "not_found"
  | "bad_request"
  | "network"
  | "bad_response";

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
 * Hibaüzenet (+ HTTP-státusz) → hibakód. Tiszta függvény, mert a döntés-naplóban ez
 * magyarázza a HOLD-ot.
 *
 * FONTOS: az OpenAI SDK időtúllépése „Request timed out.” — szóközzel. A régi
 * /timeout|abort/ minta ezt nem fogta meg, ezért minden időtúllépés „network"-ként
 * jelent meg, és rossz irányba vitte a hibakeresést.
 *
 * A státusz (ha van) erősebb az üzenetnél: egy 401 mindig `auth`, egy 404 mindig
 * `not_found` — így egy rossz kulcs vagy egy leállított modellnév (pl. `glm-4-flash`)
 * nem tűnik el névtelen „network" hibaként, hanem pontosan megnevezi magát.
 */
export function classifyLlmError(
  message: string,
  status?: number,
): Exclude<LlmErrorCode, "bad_response"> {
  // A státusz a legmegbízhatóbb jel — ha van, ez dönt.
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "bad_request";

  // Státusz nélkül (pl. hálózati/SDK-hiba) az üzenetből következtetünk.
  if (/429|rate.?limit|访问量过大/i.test(message)) return "rate_limited";
  if (/timed\s*out|timeout|abort/i.test(message)) return "timeout";
  if (/\b401\b|invalid.*api.*key|unauthorized|api key/i.test(message)) return "auth";
  if (/\b404\b|not found|(model|模型).*(not|does not).*(exist|found)|no such model/i.test(message))
    return "not_found";
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
    // Az OpenAI SDK hibái hordozzák a HTTP-státuszt (`APIError.status`); ez pontosabb,
    // mint az üzenet szövege, ezért ha van, ez osztályozza a hibát.
    const status = typeof (e as { status?: unknown })?.status === "number"
      ? (e as { status: number }).status
      : undefined;
    usage.errorCode = classifyLlmError(message, status);
    usage.errorMessage = message;
    console.error(`[LLM] hiba (${usage.errorCode}${status ? ` · HTTP ${status}` : ""}), fallback:`, message);
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
