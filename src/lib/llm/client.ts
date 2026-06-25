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

/**
 * Strukturált JSON kimenet kérése a modelltől. Ha a modell nem ad érvényes JSON-t,
 * a fallback értékkel tér vissza (a hívó felel a HOLD-ra esést). Lásd spec §6.
 */
export async function chatJson<T>(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  fallback: T,
): Promise<{ data: T; raw: string }> {
  const { client } = createLlm(model);
  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      // GLM támogatja a JSON módot — struktúrát kényszerít
      response_format: { type: "json_object" } as any,
      temperature: 0.3,
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    return { data: safeParse(raw, fallback), raw };
  } catch (e) {
    console.error("[LLM] hiba, fallback:", e);
    return { data: fallback, raw: "" };
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
