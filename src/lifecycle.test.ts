import { describe, expect, it } from "vitest";
import {
  formatIntercessorPost,
  isAcceptingPrayers,
  isExpiryPreset,
  parseStartPayload,
  resolveExpiry,
  routeAfterModeration,
} from "./lifecycle.js";

const now = new Date("2026-10-08T00:00:00Z");

describe("resolveExpiry", () => {
  it("sets a deadline for timed presets", () => {
    expect(resolveExpiry("1w", now)).toEqual({
      closeMode: "at_time",
      expiresAt: new Date("2026-10-15T00:00:00Z"),
    });
  });
  it("has no deadline for open-ended modes", () => {
    expect(resolveExpiry("until_closed", now)).toEqual({ closeMode: "until_closed", expiresAt: null });
    expect(resolveExpiry("first_prayer", now)).toEqual({ closeMode: "on_first_prayer", expiresAt: null });
  });
  it("validates preset strings", () => {
    expect(isExpiryPreset("1d")).toBe(true);
    expect(isExpiryPreset("toString")).toBe(false);
  });
});

describe("isAcceptingPrayers", () => {
  it("rejects expired requests even if the cron hasn't closed them", () => {
    expect(isAcceptingPrayers({ status: "open", expires_at: new Date(now.getTime() - 1) }, now)).toBe(false);
  });
  it("accepts open requests before expiry or with no expiry", () => {
    expect(isAcceptingPrayers({ status: "open", expires_at: new Date(now.getTime() + 1) }, now)).toBe(true);
    expect(isAcceptingPrayers({ status: "open", expires_at: null }, now)).toBe(true);
  });
  it("rejects non-open statuses", () => {
    for (const status of ["pending_review", "closed", "rejected"] as const) {
      expect(isAcceptingPrayers({ status, expires_at: null }, now)).toBe(false);
    }
  });
});

describe("routeAfterModeration", () => {
  it("publishes clean requests", () => {
    expect(routeAfterModeration({ ok: true, flagged: false, reason: "" })).toBe("publish");
  });
  it("sends flagged requests to review", () => {
    expect(routeAfterModeration({ ok: true, flagged: true, reason: "spam" })).toBe("review");
  });
  it("fails closed when moderation errors", () => {
    expect(routeAfterModeration({ ok: false, error: "timeout" })).toBe("review");
  });
});

describe("parseStartPayload", () => {
  it("parses ministry and reply links", () => {
    expect(parseStartPayload("m_12")).toEqual({ kind: "request", ministryId: 12 });
    expect(parseStartPayload("r_7")).toEqual({ kind: "reply", requestId: 7 });
  });
  it("rejects garbage", () => {
    for (const p of [undefined, "", "m_", "x_1", "m_1a", "m_-1"]) expect(parseStartPayload(p)).toBeNull();
  });
});

describe("formatIntercessorPost", () => {
  const base = {
    id: 3,
    display_name: "Grace",
    text: "Healing for my mum",
    close_mode: "until_closed" as const,
    expires_at: null,
  };
  it("hides the name when anonymous", () => {
    const post = formatIntercessorPost({ ...base, is_anonymous: true });
    expect(post).toContain("From: Anonymous");
    expect(post).not.toContain("Grace");
  });
  it("shows the name when shared", () => {
    expect(formatIntercessorPost({ ...base, is_anonymous: false })).toContain("From: Grace");
  });
});
