/**
 * Minimal Gemini client (Google AI Studio API key, free tier).
 *
 * Uses the Interactions API, which Google now documents as the default, and
 * falls back to the older generateContent endpoint if the account or model
 * doesn't support it yet. Only plain fetch, no SDK.
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Fetch = typeof fetch;

/** Pull the model's text out of either response shape. */
export function extractText(data: unknown): string {
  const d = data as Record<string, unknown>;
  // Interactions API: steps[] → model_output → content[] → text
  if (Array.isArray(d?.steps)) {
    const texts: string[] = [];
    for (const step of d.steps as Record<string, unknown>[]) {
      if (step?.type && step.type !== "model_output") continue;
      for (const c of (step?.content as Record<string, unknown>[]) ?? []) {
        if ((!c.type || c.type === "text") && typeof c.text === "string") texts.push(c.text);
      }
    }
    if (texts.length) return texts.join("");
  }
  if (typeof d?.output_text === "string") return d.output_text;
  // generateContent: candidates[0].content.parts[].text
  const parts = (d?.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined)?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p) => p.text ?? "").join("");
  return "";
}

export async function generate(
  opts: { apiKey: string; model: string; prompt: string; system?: string; signal?: AbortSignal },
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const headers = { "content-type": "application/json", "x-goog-api-key": opts.apiKey };

  let res = await fetchImpl(`${BASE}/interactions`, {
    method: "POST",
    headers,
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      input: opts.prompt,
      ...(opts.system ? { system_instruction: opts.system } : {}),
    }),
  });

  if (res.status === 404 || res.status === 400) {
    // Older accounts or models: legacy endpoint.
    res = await fetchImpl(`${BASE}/models/${encodeURIComponent(opts.model)}:generateContent`, {
      method: "POST",
      headers,
      signal: opts.signal,
      body: JSON.stringify({
        ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
        contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
      }),
    });
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GeminiError(res.status, `Gemini returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const text = extractText(await res.json()).trim();
  if (!text) throw new GeminiError(502, "Gemini returned no text");
  return text;
}
