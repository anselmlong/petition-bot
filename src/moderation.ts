import { generateText, Output } from "ai";
import { z } from "zod";
import type { ModerationResult } from "./lifecycle.js";

const verdictSchema = z.object({
  flagged: z.boolean(),
  reason: z.string().describe("One short sentence. Empty if not flagged."),
});

const SYSTEM = `You screen prayer requests submitted to a Christian intercession bot before volunteers see them.
Prayer requests are often about painful topics (illness, grief, addiction, abuse, conflict, mental health, suicidal feelings). These are LEGITIMATE and must NOT be flagged just for being heavy.
Flag only if the request is:
- spam, advertising, scams, or links unrelated to prayer
- harassment, hate, threats, or mocking/trolling
- sexually explicit content
- doxxing: full names together with addresses/phones/identifying details of third parties, or accusations naming a private person
- not a prayer request at all (gibberish, testing, off-topic chat)
- indicating imminent danger to the requester or others (flag so a human can follow up with care)
Return flagged=false otherwise.`;

export async function moderate(text: string): Promise<ModerationResult> {
  try {
    const { output } = await generateText({
      model: process.env.MODERATION_MODEL || "anthropic/claude-haiku-5.5",
      system: SYSTEM,
      prompt: `Prayer request:\n"""\n${text}\n"""`,
      output: Output.object({ schema: verdictSchema }),
      abortSignal: AbortSignal.timeout(20_000),
    });
    return { ok: true, flagged: output.flagged, reason: output.reason };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
