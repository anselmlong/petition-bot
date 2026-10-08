import { beforeEach, describe, expect, it } from "vitest";
import * as db from "./db.ts";

beforeEach(() => db.openDb(":memory:"));

function newRequest(overrides: Partial<Parameters<typeof db.createRequest>[0]> = {}) {
  const m = db.createMinistry("Test", 111, 1);
  return db.createRequest({
    ministryId: m.id, requesterId: 42, anonymous: true, displayName: "Grace",
    text: "Healing", closeMode: "until_closed", expiresAt: null, ...overrides,
  });
}

describe("db", () => {
  it("creates ministries with their creator as admin", () => {
    const m = db.createMinistry("Prayer Line", -100123, 7);
    db.addAdmin(m.id, 8);
    db.addAdmin(m.id, 8);
    expect(db.getMinistry(m.id)).toMatchObject({ intercessor_chat_id: -100123, admin_user_ids: [7, 8] });
    expect(db.listAdminMinistries(8).map((x) => x.id)).toEqual([m.id]);
  });

  it("publishes only once", () => {
    const r = newRequest();
    expect(r).toMatchObject({ status: "pending_review", is_anonymous: true });
    expect(db.publishRequest(r.id)?.status).toBe("open");
    expect(db.publishRequest(r.id)).toBeNull();
  });

  it("finalize purges content and prayers, and only succeeds once", () => {
    const r = newRequest();
    db.publishRequest(r.id);
    db.recordPrayer(r.id, 9, "God sees you");
    const before = db.finalizeRequest(r.id, "closed");
    expect(before?.text).toBe("Healing");
    expect(db.getRequest(r.id)).toMatchObject({ status: "closed", text: null, display_name: null });
    expect(db.countPrayers(r.id)).toBe(0);
    expect(db.finalizeRequest(r.id, "closed")).toBeNull();
  });

  it("lists expired open requests", () => {
    const past = newRequest({ closeMode: "at_time", expiresAt: new Date(Date.now() - 1000) });
    newRequest({ closeMode: "at_time", expiresAt: new Date(Date.now() + 60_000) });
    expect(db.listExpiredOpenRequestIds()).toEqual([]); // still pending review
    db.publishRequest(past.id);
    expect(db.listExpiredOpenRequestIds()).toEqual([past.id]);
  });

  it("round-trips user state and bans", () => {
    db.setState(5, { step: "request_text", ministryId: 1 });
    expect(db.getState(5)).toEqual({ step: "request_text", ministryId: 1 });
    db.clearState(5);
    expect(db.getState(5)).toBeNull();
    const m = db.createMinistry("x", 1, 1);
    db.ban(m.id, 5);
    expect(db.isBanned(m.id, 5)).toBe(true);
  });
});
