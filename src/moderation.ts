import type { ModerationResult } from "./lifecycle.ts";

// TypeSafe Jev answers yes/no "noul" questions with a probability, which maps directly onto
// screening. https://docs.typesafe.ai/introduction/quickstart
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

// Prayer requests are often about painful topics (grief, illness, abuse, mental health). The
// questions target misuse, not heaviness, so genuine requests pass.
export const CHECKS = {
  spam: "The message is spam, advertising, a scam, or promotes a product, service or link.",
  abusive: "The message contains harassment, hate speech, threats, or mocks prayer or religion.",
  sexual: "The message contains sexually explicit content.",
  doxxing: "The message reveals private identifying details of another person (such as an address or phone number) or publicly accuses a named private individual.",
  not_a_request: "The message is not a sincere request for prayer (for example gibberish, a test, or unrelated chat).",
  in_danger: "The writer or someone else appears to be in immediate danger, such as stating intent to end their life or ongoing violence.",
} as const;

export const FLAG_THRESHOLD = 0.5;

/** Pure: turn per-check probabilities into a verdict. A missing answer counts as a flag. */
export function verdictFromNouls(nouls: Partial<Record<keyof typeof CHECKS, number>>): ModerationResult {
  const hits = (Object.keys(CHECKS) as (keyof typeof CHECKS)[])
    .filter((k) => typeof nouls[k] !== "number" || nouls[k]! >= FLAG_THRESHOLD)
    .map((k) => `${k.replaceAll("_", " ")} (${typeof nouls[k] === "number" ? Math.round(nouls[k]! * 100) + "%" : "no answer"})`);
  return { ok: true, flagged: hits.length > 0, reason: hits.join(", ") };
}

export async function moderate(text: string): Promise<ModerationResult> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return { ok: false, error: "TYPESAFE_API_KEY not set" };
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.TYPESAFE_MODEL || "jev-latest",
        state: `A prayer request submitted to a Christian intercession group:\n\n${text}`,
        questions: Object.fromEntries(
          Object.entries(CHECKS).map(([k, instructions]) => [k, { type: "noul", instructions }]),
        ),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const body = (await res.json()) as { answers?: Record<string, { noul?: number }> };
    const nouls = Object.fromEntries(Object.entries(body.answers ?? {}).map(([k, a]) => [k, a.noul]));
    return verdictFromNouls(nouls);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
