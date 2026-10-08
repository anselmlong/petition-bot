import { waitUntil } from "@vercel/functions";
import { timingSafeEqual } from "node:crypto";
import type { Update } from "grammy/types";
import { createBot } from "../src/bot.js";
import { claimUpdate, requireEnv } from "../src/db.js";

const bot = createBot(requireEnv("TELEGRAM_BOT_TOKEN"));
let ready: Promise<void> | undefined;

function validSecret(header: string | null): boolean {
  const expected = Buffer.from(requireEnv("TELEGRAM_WEBHOOK_SECRET"));
  const got = Buffer.from(header ?? "");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export async function POST(request: Request): Promise<Response> {
  if (!validSecret(request.headers.get("x-telegram-bot-api-secret-token"))) {
    return new Response("unauthorized", { status: 401 });
  }
  const update = (await request.json()) as Update;

  // Ack immediately so Telegram doesn't retry while moderation (an LLM call) runs.
  waitUntil(
    (async () => {
      if (!(await claimUpdate(update.update_id))) return;
      ready ??= bot.init();
      await ready;
      await bot.handleUpdate(update);
    })().catch((err) => console.error("update failed", err)),
  );
  return new Response("ok");
}
