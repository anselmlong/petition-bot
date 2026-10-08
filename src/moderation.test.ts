import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECKS, moderate, verdictFromNouls } from "./moderation.ts";

const clean = Object.fromEntries(Object.keys(CHECKS).map((k) => [k, 0.02]));

describe("verdictFromNouls", () => {
  it("passes when every check is below threshold", () => {
    expect(verdictFromNouls(clean)).toEqual({ ok: true, flagged: false, reason: "" });
  });
  it("flags and names checks at or over threshold", () => {
    const v = verdictFromNouls({ ...clean, spam: 0.91 });
    expect(v).toEqual({ ok: true, flagged: true, reason: "spam (91%)" });
  });
  it("treats a missing answer as a flag", () => {
    const { in_danger, ...rest } = clean;
    expect(verdictFromNouls(rest)).toMatchObject({ flagged: true, reason: "in danger (no answer)" });
  });
});

describe("moderate", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fails closed without an API key", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(await moderate("x")).toMatchObject({ ok: false });
  });

  it("sends noul questions and reads the answers", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "k");
    const fetchMock = vi.fn(async () => Response.json({
      answers: Object.fromEntries(Object.keys(CHECKS).map((k) => [k, { type: "noul", noul: k === "sexual" ? 0.8 : 0 }])),
    }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await moderate("pray for me")).toMatchObject({ ok: true, flagged: true, reason: "sexual (80%)" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("jev-latest");
    expect(body.questions.spam).toEqual({ type: "noul", instructions: CHECKS.spam });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("fails closed on HTTP errors", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(await moderate("x")).toMatchObject({ ok: false, error: "HTTP 500: nope" });
  });
});
