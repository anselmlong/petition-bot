import { Bot, GrammyError, InlineKeyboard, type Api, type Context } from "grammy";
import type { User, UserFromGetMe } from "grammy/types";
import * as db from "./db.ts";
import {
  closesAfterPrayer,
  EXPIRY_PRESETS,
  formatIntercessorPost,
  isAcceptingPrayers,
  isExpiryPreset,
  MAX_MESSAGE_LENGTH,
  MAX_REQUEST_LENGTH,
  parseStartPayload,
  resolveExpiry,
  routeAfterModeration,
} from "./lifecycle.ts";
import { moderate } from "./moderation.ts";
import { fallBackToAdminDm, registerSetup } from "./setup.ts";
import { deepLink, fullName, isMemberOf, trySend } from "./tg.ts";

const HELP = `🙏 Petition Bot

Asking for prayer:
• Tap your community's 🙏 Request prayer link or button
• /myrequests: see, close or delete your requests
• /cancel: stop what you're typing

Running a prayer ministry:
• /setup: guided setup (about a minute)
• /manage: share link, invite admins, change groups

Advanced: /newministry <name>, /link <id>, /ministries, /linkintercessors <id>, /linkrequestors <id> [@channel], /addadmin <id> (as a reply)`;

function intercessorKeyboard(bot: Bot, requestId: number) {
  return new InlineKeyboard()
    .text("🙏 I prayed", `pr:${requestId}`)
    .url("✉️ Pray + send a message", deepLink(bot, `r_${requestId}`))
    .row()
    .text("🗑 Remove (admins)", `rm:${requestId}`);
}

// ---------- lifecycle actions (shared with the cron) ----------

async function publish(bot: Bot, requestId: number): Promise<void> {
  const req = await db.publishRequest(requestId);
  if (!req) return;
  const ministry = await db.getMinistry(req.ministry_id);
  if (!ministry) return;
  const post = (chatId: number) => trySend(bot.api, chatId, formatIntercessorPost(req), {
    reply_markup: intercessorKeyboard(bot, req.id),
  });
  let msg = await post(ministry.intercessor_chat_id);
  if (!msg && ministry.intercessor_chat_id < 0) {
    // Bot was likely removed from the group or lost permission: keep prayer flowing via an admin.
    const healed = await fallBackToAdminDm(bot.api, ministry, "I couldn't post in your intercessors' group");
    msg = await post(healed.intercessor_chat_id);
  }
  if (!msg) {
    console.error(`request #${req.id}: could not reach any intercessor chat`);
    await trySend(bot.api, req.requester_tg_id, `📨 Your prayer request #${req.id} was received. You'll be notified when someone prays.`);
    return;
  }
  await db.setIntercessorMessage(req.id, msg.message_id);
  await trySend(bot.api, req.requester_tg_id, `✅ Your prayer request #${req.id} has been shared with ${ministry.name}. You'll be notified when someone prays.`);
}

async function sendToReview(bot: Bot, req: db.PrayerRequest, reason: string): Promise<void> {
  const ministry = await db.getMinistry(req.ministry_id);
  if (!ministry) return;
  const text = [
    `⚠️ Request #${req.id} for "${ministry.name}" needs review`,
    `From: ${req.display_name ?? "?"} [id ${req.requester_tg_id}]${req.is_anonymous ? " — anonymous to intercessors" : ""}`,
    `Flag: ${reason}`,
    "",
    req.text ?? "",
  ].join("\n");
  const kb = new InlineKeyboard()
    .text("✅ Approve", `ap:${req.id}`)
    .text("❌ Reject", `rj:${req.id}`)
    .text("⛔ Reject + ban", `bn:${req.id}`);
  for (const adminId of ministry.admin_user_ids) await trySend(bot.api, adminId, text, { reply_markup: kb });
  await trySend(bot.api, req.requester_tg_id, `📨 Your request #${req.id} was received and is waiting for a quick review.`);
}

async function submit(bot: Bot, req: db.PrayerRequest): Promise<void> {
  const result = await moderate(req.text ?? "");
  const reason = result.ok ? result.reason : `automatic screening unavailable (${result.error})`;
  if (reason) await db.setModerationReason(req.id, reason);
  if (routeAfterModeration(result) === "publish") await publish(bot, req.id);
  else await sendToReview(bot, req, reason || "flagged");
}

export type CloseHow = "closed" | "expired" | "deleted" | "rejected" | "prayed";

/** Ends a request, purges its content, updates the intercessor post and tells the requester. */
export async function endRequest(api: Api, requestId: number, how: CloseHow): Promise<boolean> {
  const prayed = await db.countPrayers(requestId);
  const req = await db.finalizeRequest(requestId, how === "rejected" ? "rejected" : "closed");
  if (!req) return false;

  const ministry = await db.getMinistry(req.ministry_id);
  if (ministry && req.intercessor_message_id) {
    const chat = ministry.intercessor_chat_id;
    const mid = req.intercessor_message_id;
    if (how === "deleted") {
      // Bots can't delete group messages older than 48h; fall back to blanking it.
      await api.deleteMessage(chat, mid).catch(() =>
        api.editMessageText(chat, mid, `🗑 Prayer request #${req.id} was removed.`).catch(() => {}));
    } else {
      await api.editMessageText(chat, mid, `✅ Prayer request #${req.id} has closed. Thank you for praying.`).catch(() => {});
    }
  }

  const times = prayed === 1 ? "once" : `${prayed} times`;
  const notice: Record<CloseHow, string> = {
    closed: `Your request #${req.id} is closed. It was prayed for ${times}. 🙏`,
    expired: `Your request #${req.id} has reached its end date and is now closed. It was prayed for ${times}. 🙏`,
    prayed: `Your request #${req.id} has been prayed for and is now closed. 🙏`,
    deleted: `Your request #${req.id} has been deleted.`,
    rejected: `Sorry, your request #${req.id} couldn't be shared with intercessors. If you think this is a mistake, please contact the ministry.`,
  };
  await trySend(api, req.requester_tg_id, notice[how]);
  return true;
}

async function recordAndDeliverPrayer(api: Api, req: db.PrayerRequest, from: User, message: string | null) {
  const prayerId = await db.recordPrayer(req.id, from.id, message);
  const text = message
    ? `✉️ ${from.first_name} prayed for your request #${req.id} and sent you this:\n\n${message}`
    : `🙏 ${from.first_name} just prayed for your request #${req.id}.`;
  const sent = await trySend(api, req.requester_tg_id, text);
  if (sent) await db.markPrayerDelivered(prayerId);
  if (closesAfterPrayer(req)) await endRequest(api, req.id, "prayed");
}

// ---------- bot ----------

export function createBot(token: string, botInfo?: UserFromGetMe): Bot {
  const bot = new Bot(token, { botInfo });
  const isPrivate = (ctx: Context) => ctx.chat?.type === "private";
  const setup = registerSetup(bot);

  async function requireAdmin(ctx: Context, ministryId: number): Promise<db.Ministry | null> {
    const ministry = Number.isSafeInteger(ministryId) ? await db.getMinistry(ministryId) : null;
    if (!ministry || !ctx.from || !ministry.admin_user_ids.includes(ctx.from.id)) {
      await ctx.reply("You're not an admin of that ministry.");
      return null;
    }
    return ministry;
  }

  // --- /start and request submission ---

  bot.command("start", async (ctx) => {
    if (!ctx.from) return;
    const payload = parseStartPayload(ctx.match);
    if (!isPrivate(ctx)) {
      // Sent by Telegram when an admin uses an add-to-group link from the setup wizard.
      if (payload?.kind === "link") await setup.groupStart(ctx, payload.role, payload.ministryId);
      return;
    }
    if (!payload || payload.kind === "link") return setup.welcome(ctx);
    if (payload.kind === "invite") return setup.acceptInvite(ctx, payload.token);

    if (payload.kind === "request") {
      const ministry = await db.getMinistry(payload.ministryId);
      if (!ministry) return ctx.reply("That prayer link isn't valid anymore.");
      if (await db.isBanned(ministry.id, ctx.from.id)) return ctx.reply("You can't submit requests to this ministry.");
      if (ministry.requestor_chat_id && !(await isMemberOf(ctx.api, ministry.requestor_chat_id, ctx.from.id))) {
        return ctx.reply(`This prayer link is only for members of ${ministry.name}'s community.`);
      }
      await db.setState(ctx.from.id, { step: "request_text", ministryId: ministry.id });
      return ctx.reply(`🙏 What would you like ${ministry.name} to pray for?\n\nType your request below (max ${MAX_REQUEST_LENGTH} characters). /cancel to stop.`);
    }

    const req = await db.getRequest(payload.requestId);
    const ministry = req && (await db.getMinistry(req.ministry_id));
    if (!req || !ministry || !isAcceptingPrayers(req, new Date())) return ctx.reply("That request has closed. 🙏");
    if (!(await isMemberOf(ctx.api, ministry.intercessor_chat_id, ctx.from.id))) {
      return ctx.reply("Only intercessors for this ministry can reply to that request.");
    }
    await db.setState(ctx.from.id, { step: "reply_text", requestId: req.id });
    await ctx.reply(`${formatIntercessorPost(req)}\n\n———\nType the message you'd like to send back after praying. It is delivered once and then deleted. /cancel to stop.`);
  });

  bot.command("help", (ctx) => ctx.reply(HELP));

  bot.command("cancel", async (ctx) => {
    if (!ctx.from) return;
    await db.clearState(ctx.from.id);
    await ctx.reply("Cancelled.");
  });

  bot.on("message:text", async (ctx, next) => {
    if (!isPrivate(ctx) || ctx.message.text.startsWith("/")) return next();
    const state = await db.getState(ctx.from.id);
    const text = ctx.message.text.trim();

    if (state?.step === "request_text") {
      if (text.length > MAX_REQUEST_LENGTH) return ctx.reply(`That's a bit long — please keep it under ${MAX_REQUEST_LENGTH} characters.`);
      await db.setState(ctx.from.id, { step: "request_anon", ministryId: state.ministryId, text });
      return ctx.reply("Would you like to share your name with the intercessors?", {
        reply_markup: new InlineKeyboard()
          .text("🙈 Stay anonymous", "anon:y")
          .text(`🙋 Share as ${ctx.from.first_name}`, "anon:n"),
      });
    }

    if (state?.step === "reply_text") {
      if (text.length > MAX_MESSAGE_LENGTH) return ctx.reply(`Please keep it under ${MAX_MESSAGE_LENGTH} characters.`);
      await db.clearState(ctx.from.id);
      const req = await db.getRequest(state.requestId);
      if (!req || !isAcceptingPrayers(req, new Date())) return ctx.reply("That request closed before your message was sent.");
      await recordAndDeliverPrayer(ctx.api, req, ctx.from, text);
      return ctx.reply("🙏 Thank you — your message was delivered.");
    }

    if (await setup.onText(ctx, state, text)) return;
    return ctx.reply(HELP);
  });

  bot.callbackQuery(/^anon:(y|n)$/, async (ctx) => {
    const state = await db.getState(ctx.from.id);
    if (state?.step !== "request_anon") return ctx.answerCallbackQuery("This step has expired. Open the link again.");
    const anonymous = ctx.match[1] === "y";
    await db.setState(ctx.from.id, { step: "request_expiry", ministryId: state.ministryId, text: state.text, anonymous });
    const kb = new InlineKeyboard();
    for (const [key, { label }] of Object.entries(EXPIRY_PRESETS)) kb.text(label, `exp:${key}`).row();
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`${anonymous ? "Anonymous" : "Sharing your name"}. How long should people keep praying?`, { reply_markup: kb });
  });

  bot.callbackQuery(/^exp:(\w+)$/, async (ctx) => {
    const preset = ctx.match[1]!;
    const state = await db.getState(ctx.from.id);
    if (state?.step !== "request_expiry" || !isExpiryPreset(preset)) {
      return ctx.answerCallbackQuery("This step has expired. Open the link again.");
    }
    await db.clearState(ctx.from.id);
    const { closeMode, expiresAt } = resolveExpiry(preset, new Date());
    const req = await db.createRequest({
      ministryId: state.ministryId,
      requesterId: ctx.from.id,
      anonymous: state.anonymous,
      displayName: fullName(ctx.from), // shown to admins during review; hidden from intercessors if anonymous
      text: state.text,
      closeMode,
      expiresAt,
    });
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`🙏 Request #${req.id} submitted (${EXPIRY_PRESETS[preset].label.toLowerCase()}). Checking it now…`);
    // Polling handles updates one at a time; don't hold everyone up while moderation runs.
    void submit(bot, req).catch((err) => console.error(`submit #${req.id} failed`, err));
  });

  // --- intercessor actions ---

  bot.callbackQuery(/^pr:(\d+)$/, async (ctx) => {
    const req = await db.getRequest(Number(ctx.match[1]));
    if (!req || !isAcceptingPrayers(req, new Date())) return ctx.answerCallbackQuery("This request has closed.");
    await recordAndDeliverPrayer(ctx.api, req, ctx.from, null);
    await ctx.answerCallbackQuery("Thank you for praying 🙏 The requester has been told.");
  });

  bot.callbackQuery(/^rm:(\d+)$/, async (ctx) => {
    const req = await db.getRequest(Number(ctx.match[1]));
    const ministry = req && (await db.getMinistry(req.ministry_id));
    if (!req || !ministry?.admin_user_ids.includes(ctx.from.id)) return ctx.answerCallbackQuery("Only ministry admins can remove requests.");
    await endRequest(ctx.api, req.id, "deleted");
    await ctx.answerCallbackQuery("Removed.");
  });

  // --- admin review ---

  bot.callbackQuery(/^(ap|rj|bn):(\d+)$/, async (ctx) => {
    const [, action, id] = ctx.match;
    const req = await db.getRequest(Number(id));
    const ministry = req && (await db.getMinistry(req.ministry_id));
    if (!req || !ministry?.admin_user_ids.includes(ctx.from.id)) return ctx.answerCallbackQuery("Not allowed.");
    if (req.status !== "pending_review") {
      await ctx.answerCallbackQuery("Already handled.");
      return ctx.editMessageReplyMarkup().catch(() => {});
    }
    if (action === "ap") await publish(bot, req.id);
    else {
      if (action === "bn") await db.ban(req.ministry_id, req.requester_tg_id);
      await endRequest(ctx.api, req.id, "rejected");
    }
    const verdict = { ap: "✅ Approved", rj: "❌ Rejected", bn: "⛔ Rejected and banned" }[action as "ap" | "rj" | "bn"];
    await ctx.answerCallbackQuery(verdict);
    await ctx.editMessageText(`${verdict} request #${req.id} (by ${ctx.from.first_name}).`).catch(() => {});
  });

  // --- requestor management ---

  bot.command("myrequests", async (ctx) => {
    if (!isPrivate(ctx) || !ctx.from) return;
    const now = new Date();
    const reqs = await db.listActiveRequestsFor(ctx.from.id);
    if (reqs.length === 0) return ctx.reply("You have no open requests.");
    const kb = new InlineKeyboard();
    const lines = await Promise.all(reqs.map(async (r) => {
      kb.text(`✅ Close #${r.id}`, `cl:${r.id}`).text(`🗑 Delete #${r.id}`, `dl:${r.id}`).row();
      const state = r.status === "pending_review" ? "in review" :
        isAcceptingPrayers(r, now) ? `prayed ${await db.countPrayers(r.id)}×` : "expired";
      const preview = (r.text ?? "").slice(0, 60);
      return `#${r.id} (${state}, ${r.is_anonymous ? "anonymous" : "named"}) — ${preview}`;
    }));
    await ctx.reply(lines.join("\n"), { reply_markup: kb });
  });

  bot.callbackQuery(/^(cl|dl):(\d+)$/, async (ctx) => {
    const [, action, id] = ctx.match;
    const req = await db.getRequest(Number(id));
    if (!req || req.requester_tg_id !== ctx.from.id) return ctx.answerCallbackQuery("Not found.");
    const ok = await endRequest(ctx.api, req.id, action === "cl" ? "closed" : "deleted");
    await ctx.answerCallbackQuery(ok ? "Done." : "Already closed.");
  });

  // --- ministry admin setup ---

  bot.command("newministry", async (ctx) => {
    if (!isPrivate(ctx) || !ctx.from) return ctx.reply("DM me /setup to create a ministry.");
    const name = ctx.match.trim();
    if (!name) return ctx.reply("Usage: /newministry <name>, or just use /setup for a guided version.");
    await setup.onText(ctx, { step: "setup_name" }, name);
  });

  bot.command("link", async (ctx) => {
    const m = await requireAdmin(ctx, Number(ctx.match.trim()));
    if (m) await ctx.reply(`Request link for ${m.name}:\n${deepLink(bot, `m_${m.id}`)}`);
  });

  bot.command("ministries", async (ctx) => {
    if (!ctx.from) return;
    const list = await db.listAdminMinistries(ctx.from.id);
    await ctx.reply(list.length ? list.map((m) => `${m.id}: ${m.name}`).join("\n") : "You don't admin any ministries yet.");
  });

  bot.command("linkintercessors", async (ctx) => {
    if (isPrivate(ctx)) return ctx.reply("Run this inside the intercessors' group.");
    const m = await requireAdmin(ctx, Number(ctx.match.trim()));
    if (!m) return;
    await db.setIntercessorChat(m.id, ctx.chat.id);
    await ctx.reply(`This group now receives prayer requests for ${m.name}. 🙏`);
  });

  bot.command("linkrequestors", async (ctx) => {
    const [idArg, chatArg] = ctx.match.trim().split(/\s+/);
    const m = await requireAdmin(ctx, Number(idArg));
    if (!m) return;
    let chatId = ctx.chat.id;
    if (isPrivate(ctx)) {
      if (!chatArg) return ctx.reply("Usage (in DM): /linkrequestors <id> <@channel or chat id>, or run it inside the group.");
      try {
        chatId = (await ctx.api.getChat(/^-?\d+$/.test(chatArg) ? Number(chatArg) : chatArg)).id;
      } catch {
        return ctx.reply("I can't see that chat. Add me to it (as an admin for channels) first.");
      }
    }
    if (!(await isMemberOf(ctx.api, chatId, ctx.from!.id))) return ctx.reply("You need to be a member of that chat.");
    await db.setRequestorChat(m.id, chatId);
    const kb = new InlineKeyboard().url("🙏 Request prayer", deepLink(bot, `m_${m.id}`));
    await trySend(ctx.api, chatId, `Need prayer? Tap below to send a private request to ${m.name}. You can stay anonymous.`, { reply_markup: kb });
    if (isPrivate(ctx)) await ctx.reply("Linked. Only members of that chat can submit requests now.");
  });

  bot.command("addadmin", async (ctx) => {
    const target = ctx.message?.reply_to_message?.from;
    if (!target || target.is_bot) return ctx.reply("Reply to a message from the person you want to add, with /addadmin <ministry id>.");
    const m = await requireAdmin(ctx, Number(ctx.match.trim()));
    if (!m) return;
    await db.addAdmin(m.id, target.id);
    await ctx.reply(`${target.first_name} is now an admin of ${m.name}. They should DM me once so I can reach them.`);
  });

  bot.catch((err) => {
    const e = err.error;
    console.error(`Error handling update ${err.ctx.update.update_id}:`, e instanceof GrammyError ? e.description : e);
  });

  return bot;
}
