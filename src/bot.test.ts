// Drives the real handlers with a fake Telegram API: no network, in-memory SQLite.
import type { Update } from "grammy/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBot, endRequest } from "./bot.ts";
import * as db from "./db.ts";
import { CHECKS } from "./moderation.ts";

const BOT = { id: 999, is_bot: true as const, first_name: "Petition", username: "petition_test_bot",
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false };

const ADMIN = { id: 1, is_bot: false, first_name: "Pastor" };
const ALICE = { id: 2, is_bot: false, first_name: "Alice", last_name: "Tan" };
const INTERCESSOR = { id: 3, is_bot: false, first_name: "Ben" };
const GROUP = -100500;

type Call = { method: string; payload: any };
let calls: Call[];
let nextMessageId: number;
let updateId: number;
let bot: ReturnType<typeof createBot>;

function setup() {
  db.openDb(":memory:");
  calls = [];
  nextMessageId = 1000;
  updateId = 1;
  bot = createBot("test", BOT as any);
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    const result =
      method === "getChatMember" ? { status: (payload as any).user_id === ALICE.id ? "left" : "member", user: {} } :
      method === "sendMessage" ? { message_id: nextMessageId++, chat: { id: (payload as any).chat_id }, date: 0 } :
      true;
    return { ok: true, result } as any;
  });
}

const sent = (chatId: number) => calls.filter((c) => c.method === "sendMessage" && c.payload.chat_id === chatId);
const lastText = (chatId: number) => sent(chatId).at(-1)?.payload.text as string;

async function dm(from: typeof ADMIN, text: string, chatType: "private" | "supergroup" = "private", chatId = from.id) {
  const entities = text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] : undefined;
  await bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: updateId, date: 0, from, text, entities,
      chat: chatType === "private" ? { id: chatId, type: "private", first_name: from.first_name } : { id: chatId, type: "supergroup", title: "G" } },
  } as Update);
}

async function tap(from: typeof ADMIN, data: string, chatId = from.id) {
  await bot.handleUpdate({
    update_id: updateId++,
    callback_query: { id: String(updateId), from, chat_instance: "x", data,
      message: { message_id: 1, date: 0, chat: { id: chatId, type: "private", first_name: "x" }, text: "x" } },
  } as Update);
}

function stubModeration(nouls: Partial<Record<keyof typeof CHECKS, number>> | "error") {
  vi.stubEnv("TYPESAFE_API_KEY", "k");
  vi.stubGlobal("fetch", vi.fn(async () => nouls === "error"
    ? new Response("down", { status: 503 })
    : Response.json({ answers: Object.fromEntries(Object.keys(CHECKS).map((k) => [k, { noul: nouls[k as keyof typeof CHECKS] ?? 0 }])) })));
}

async function submitRequest(ministryId: number, from: typeof ADMIN, text: string, anon: "y" | "n", preset: string) {
  await dm(from, `/start m_${ministryId}`);
  await dm(from, text);
  await tap(from, `anon:${anon}`);
  await tap(from, `exp:${preset}`);
  await vi.waitFor(() => expect(db.getRequest(db.listActiveRequestsFor(from.id)[0]!.id)?.moderation_reason).not.toBeUndefined());
  return db.listActiveRequestsFor(from.id)[0]!;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setup();
});

describe("individual intercessor (solo) flow", () => {
  it("clean anonymous request reaches the intercessor without the name, and a prayer reaches the requester", async () => {
    stubModeration({});
    await dm(ADMIN, "/newministry Pastor's Line");
    expect(lastText(ADMIN.id)).toContain("https://t.me/petition_test_bot?start=m_1");

    await submitRequest(1, ALICE, "Please pray for my exams", "y", "1w");
    await vi.waitFor(() => expect(db.listActiveRequestsFor(ALICE.id)[0]?.status).toBe("open"));

    const post = lastText(ADMIN.id);
    expect(post).toContain("From: Anonymous");
    expect(post).toContain("Please pray for my exams");
    expect(post).not.toContain("Alice");
    const buttons = sent(ADMIN.id).at(-1)!.payload.reply_markup.inline_keyboard.flat();
    expect(buttons.map((b: any) => b.callback_data ?? b.url)).toContain("https://t.me/petition_test_bot?start=r_1");

    await tap(ADMIN, "pr:1");
    expect(lastText(ALICE.id)).toBe("🙏 Pastor just prayed for your request #1.");
  });

  it("named request shows the requester's name", async () => {
    stubModeration({});
    await dm(ADMIN, "/newministry Line");
    await submitRequest(1, ALICE, "Job interview", "n", "until_closed");
    await vi.waitFor(() => expect(lastText(ADMIN.id)).toContain("From: Alice Tan"));
  });
});

describe("group flow with messages and expiry modes", () => {
  async function groupMinistry() {
    await dm(ADMIN, "/newministry Cell Group");
    await dm(ADMIN, "/linkintercessors 1", "supergroup", GROUP);
    expect(db.getMinistry(1)?.intercessor_chat_id).toBe(GROUP);
  }

  it("intercessor replies with a message; 'once someone prays' closes and purges", async () => {
    stubModeration({});
    await groupMinistry();
    const req = await submitRequest(1, ALICE, "Healing for mum", "y", "first_prayer");
    await vi.waitFor(() => expect(lastText(GROUP)).toContain("Healing for mum"));

    await dm(INTERCESSOR, `/start r_${req.id}`);
    await dm(INTERCESSOR, "I sense peace over your family.");
    expect(sent(ALICE.id).map((c) => c.payload.text)).toContain(
      `✉️ Ben prayed for your request #${req.id} and sent you this:\n\nI sense peace over your family.`);
    expect(db.getRequest(req.id)).toMatchObject({ status: "closed", text: null });
    expect(calls.some((c) => c.method === "editMessageText" && c.payload.chat_id === GROUP && c.payload.text.includes("has closed"))).toBe(true);

    await tap(INTERCESSOR, `pr:${req.id}`, GROUP);
    expect(calls.at(-1)).toMatchObject({ method: "answerCallbackQuery", payload: { text: "This request has closed." } });
  });

  it("restricts submission to the requestor group's members", async () => {
    await groupMinistry();
    await dm(ADMIN, "/linkrequestors 1", "supergroup", -100600);
    await dm(ALICE, "/start m_1"); // fake API says Alice has left
    expect(lastText(ALICE.id)).toContain("only for members");
  });

  it("expired requests stop accepting prayers before the sweep runs, then the sweep closes them", async () => {
    stubModeration({});
    await groupMinistry();
    const req = await submitRequest(1, ALICE, "Exams", "y", "1d");
    await vi.waitFor(() => expect(db.getRequest(req.id)?.status).toBe("open"));
    vi.useFakeTimers({ now: Date.now() + 2 * 24 * 60 * 60 * 1000, toFake: ["Date"] });
    try {
      await tap(INTERCESSOR, `pr:${req.id}`, GROUP);
      expect(calls.at(-1)?.payload.text).toBe("This request has closed.");
      expect(db.listExpiredOpenRequestIds()).toEqual([req.id]);
      await endRequest(bot.api, req.id, "expired");
      expect(lastText(ALICE.id)).toContain("reached its end date");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("vetting", () => {
  it("flagged request goes to admins with identity; reject + ban blocks the user", async () => {
    stubModeration({ spam: 0.97 });
    await dm(ADMIN, "/newministry Line");
    const req = await submitRequest(1, ALICE, "BUY CRYPTO NOW", "y", "1d");
    const review = sent(ADMIN.id).at(-1)!.payload;
    expect(review.text).toContain("needs review");
    expect(review.text).toContain("Alice Tan");
    expect(review.text).toContain("spam (97%)");
    expect(db.getRequest(req.id)?.status).toBe("pending_review");

    await tap(ALICE, `bn:${req.id}`); // not an admin
    expect(db.getRequest(req.id)?.status).toBe("pending_review");

    await tap(ADMIN, `bn:${req.id}`);
    expect(db.getRequest(req.id)).toMatchObject({ status: "rejected", text: null });
    expect(lastText(ALICE.id)).toContain("couldn't be shared");
    await dm(ALICE, "/start m_1");
    expect(lastText(ALICE.id)).toContain("can't submit");
  });

  it("moderation outage fails closed to human review, and approval publishes", async () => {
    stubModeration("error");
    await dm(ADMIN, "/newministry Line");
    const req = await submitRequest(1, ALICE, "Pray for rain", "n", "1d");
    expect(lastText(ADMIN.id)).toContain("screening unavailable");
    await tap(ADMIN, `ap:${req.id}`);
    expect(db.getRequest(req.id)?.status).toBe("open");
    expect(sent(ADMIN.id).some((c) => c.payload.text.startsWith(`🙏 Prayer request #${req.id}`))).toBe(true);
  });
});

describe("requester controls", () => {
  it("delete removes the intercessor post and purges", async () => {
    stubModeration({});
    await dm(ADMIN, "/newministry Line");
    const req = await submitRequest(1, ALICE, "Secret", "y", "until_closed");
    await vi.waitFor(() => expect(db.getRequest(req.id)?.intercessor_message_id).toBeTruthy());
    await tap(BOB_NOT_OWNER, `dl:${req.id}`);
    expect(db.getRequest(req.id)?.status).toBe("open");
    await tap(ALICE, `dl:${req.id}`);
    expect(calls.some((c) => c.method === "deleteMessage")).toBe(true);
    expect(db.getRequest(req.id)).toMatchObject({ status: "closed", text: null });
  });
});

const BOB_NOT_OWNER = { id: 77, is_bot: false, first_name: "Bob" };
