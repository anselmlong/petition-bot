// Guided setup and the /manage panel. Admins never type ids or commands inside groups:
// they tap buttons, and Telegram's add-to-group / add-to-channel links do the linking.
import { InlineKeyboard, type Api, type Bot, type Context } from "grammy";
import type { Chat, User } from "grammy/types";
import * as db from "./db.ts";
import { addToChannelLink, addToGroupLink, deepLink, fullName, trySend } from "./tg.ts";

type Role = "intercessor" | "requestor";
type LinkableChat = Pick<Chat, "id" | "type"> & { title?: string };

// Telegram shows group admins who "remain anonymous" as this user.
const GROUP_ANONYMOUS_BOT = 1087968824;

async function chatLabel(api: Api, chatId: number, viewerId?: number): Promise<string> {
  if (chatId === viewerId) return "this chat (you)";
  if (chatId > 0) return "another admin's private chat";
  try {
    const chat = await api.getChat(chatId);
    return "title" in chat && chat.title ? `"${chat.title}"` : "a group";
  } catch {
    return "a chat I can no longer reach";
  }
}

// ---------- wizard steps ----------
// Callback data `w:<action>:<ministryId>:<wizard 1|0>`. Wizard mode chains into the next step;
// otherwise (from /manage) a single change is made.

function whoPraysStep(m: db.Ministry, wizard: boolean) {
  const w = wizard ? 1 : 0;
  return {
    text: `${wizard ? "Step 2 of 3 · " : ""}Who will pray for requests sent to ${m.name}?`,
    reply_markup: new InlineKeyboard()
      .text("🙋 Just me", `w:me:${m.id}:${w}`).row()
      .text("👥 A group of intercessors", `w:ig:${m.id}:${w}`),
  };
}

function intercessorGroupStep(bot: Bot, m: db.Ministry, wizard: boolean) {
  return {
    text:
      "Tap the button below and choose your intercessors' group. I'll join it and link it automatically. There's nothing to type.\n\n" +
      "Heads-up: everyone in that group will see the text of each request. People who choose to stay anonymous stay anonymous.\n\n" +
      "Is the group missing from the list? You need to be allowed to add members to it.",
    reply_markup: new InlineKeyboard()
      .url("➕ Add me to the intercessors' group", addToGroupLink(bot, `si_${m.id}`)).row()
      .text("↩️ Just me for now", `w:me:${m.id}:${wizard ? 1 : 0}`),
  };
}

function whereFromStep(m: db.Ministry, wizard: boolean) {
  const w = wizard ? 1 : 0;
  return {
    text: `${wizard ? "Step 3 of 3 · " : ""}Where will people ask for prayer?`,
    reply_markup: new InlineKeyboard()
      .text("📣 From my channel", `w:rc:${m.id}:${w}`).row()
      .text("💬 From a group chat", `w:rg:${m.id}:${w}`).row()
      .text("🔗 Anywhere, just give me a link", `w:rl:${m.id}:${w}`),
  };
}

function channelStep(bot: Bot, m: db.Ministry, wizard: boolean) {
  return {
    text:
      "Tap below, choose your channel, and confirm. I only ask for permission to post, so I can put a " +
      "🙏 Request prayer button there. Only channel members will be able to send requests.",
    reply_markup: new InlineKeyboard()
      .url("➕ Add me to my channel", addToChannelLink(bot)).row()
      .text("🔗 Skip, just give me a link", `w:rl:${m.id}:${wizard ? 1 : 0}`),
  };
}

function requestorGroupStep(bot: Bot, m: db.Ministry, wizard: boolean) {
  return {
    text:
      "Tap below and choose the group where people will ask for prayer. I'll post a 🙏 Request prayer button there. " +
      "Only members of that group will be able to send requests.\n\n" +
      "Requests are always sent to me privately, so nobody in the group sees who asked.",
    reply_markup: new InlineKeyboard()
      .url("➕ Add me to the group", addToGroupLink(bot, `sr_${m.id}`)).row()
      .text("🔗 Skip, just give me a link", `w:rl:${m.id}:${wizard ? 1 : 0}`),
  };
}

/** The forwardable card people tap to request prayer. */
function shareCard(bot: Bot, m: db.Ministry) {
  return {
    text: `🙏 Need prayer?\n\nTap below to send a private prayer request to ${m.name}. You can stay anonymous and choose how long people keep praying.`,
    reply_markup: new InlineKeyboard().url("🙏 Request prayer", deepLink(bot, `m_${m.id}`)),
  };
}

async function sendShareKit(bot: Bot, chatId: number, m: db.Ministry) {
  const card = shareCard(bot, m);
  await trySend(bot.api, chatId, card.text, { reply_markup: card.reply_markup });
  await trySend(bot.api, chatId, `👆 Forward that message to your community, or share this link anywhere:\n${deepLink(bot, `m_${m.id}`)}`);
}

async function finishWizard(bot: Bot, chatId: number, m: db.Ministry) {
  const fresh = db.getMinistry(m.id) ?? m;
  await trySend(bot.api, chatId, `🎉 ${fresh.name} is ready!\n\n${await summary(bot.api, fresh, chatId)}`);
  await sendShareKit(bot, chatId, fresh);
  await trySend(bot.api, chatId,
    "Try it now: tap your own link and send a test request. You'll see exactly what requesters and intercessors see.\n\n" +
    "Change anything later with /manage.");
}

async function summary(api: Api, m: db.Ministry, viewerId: number): Promise<string> {
  const who = await chatLabel(api, m.intercessor_chat_id, viewerId);
  const from = m.requestor_chat_id ? `members of ${await chatLabel(api, m.requestor_chat_id)}` : "anyone with your link";
  return `🙏 Requests go to: ${who}\n📣 Who can ask: ${from}`;
}

// ---------- linking ----------

/**
 * Links a chat to a ministry role and tells everyone what happened. Shared by both linking
 * signals (the group /start payload and the bot-added update), so it is idempotent.
 */
async function linkChat(bot: Bot, m: db.Ministry, role: Role, chat: LinkableChat, actor: User, wizard: boolean): Promise<void> {
  const current = role === "intercessor" ? m.intercessor_chat_id : m.requestor_chat_id;
  const other = role === "intercessor" ? m.requestor_chat_id : m.intercessor_chat_id;
  if (current === chat.id) return;

  if (chat.id === other) {
    await trySend(bot.api, actor.id,
      role === "intercessor"
        ? `⚠️ ${chat.title ?? "That chat"} is where people ask for prayer, so it can't also be the intercessors' chat. Everyone would see every request. Please pick a separate group.`
        : `⚠️ ${chat.title ?? "That chat"} is your intercessors' group, so it can't also be where people ask. Please pick a different chat.`);
    return;
  }
  if (role === "intercessor" && chat.type === "channel") {
    await trySend(bot.api, actor.id, "⚠️ Intercessors need a group, not a channel, so they can tap the prayer buttons.");
    return;
  }

  if (role === "intercessor") {
    db.setIntercessorChat(m.id, chat.id);
    await trySend(bot.api, chat.id,
      `🙏 This group now receives prayer requests for ${m.name}.\n\n` +
      "When a request arrives, tap 🙏 I prayed, or ✉️ to send the person a message. " +
      "Everyone here sees the request text. People who choose to stay anonymous stay anonymous.");
  } else {
    db.setRequestorChat(m.id, chat.id);
    const card = shareCard(bot, m);
    await trySend(bot.api, chat.id, card.text, { reply_markup: card.reply_markup });
  }

  const state = db.getState(actor.id);
  if (state?.step === "setup_await_chat" && state.ministryId === m.id) db.clearState(actor.id);

  const label = chat.title ? `"${chat.title}"` : "the chat";
  await trySend(bot.api, actor.id, role === "intercessor"
    ? `✅ Linked ${label}. New requests will be posted there.`
    : `✅ Linked ${label}. I posted a 🙏 Request prayer button there. Pin it so people can find it.`);

  const fresh = db.getMinistry(m.id)!;
  if (wizard && role === "intercessor") {
    const step = whereFromStep(fresh, true);
    await trySend(bot.api, actor.id, step.text, { reply_markup: step.reply_markup });
  } else if (wizard) {
    await finishWizard(bot, actor.id, fresh);
  }
}

/**
 * If the intercessor group is unusable, send requests to the first admin's DM instead so
 * prayer keeps flowing, and tell the admins. Returns the updated ministry.
 */
export async function fallBackToAdminDm(api: Api, m: db.Ministry, why: string): Promise<db.Ministry> {
  const adminId = m.admin_user_ids[0];
  if (adminId === undefined || m.intercessor_chat_id === adminId) return m;
  db.setIntercessorChat(m.id, adminId);
  for (const id of m.admin_user_ids) {
    await trySend(api, id, `⚠️ ${why}, so new requests for ${m.name} will come to ${id === adminId ? "this chat" : "the first admin's private chat"} for now.\n\nUse /manage → 🙏 Who prays to pick a group again.`);
  }
  return db.getMinistry(m.id)!;
}

async function handleBotRemoved(api: Api, chatId: number): Promise<void> {
  for (const m of db.ministriesUsingChat(chatId)) {
    if (m.intercessor_chat_id === chatId) await fallBackToAdminDm(api, m, "I was removed from your intercessors' group");
    if (m.requestor_chat_id === chatId) {
      db.setRequestorChat(m.id, null);
      for (const id of m.admin_user_ids) {
        await trySend(api, id, `⚠️ I was removed from the chat where people ask for prayer for ${m.name}. For now, anyone with your link can send requests.\n\nUse /manage → 📣 Who can ask to change this.`);
      }
    }
  }
}

// ---------- /manage ----------

async function panel(bot: Bot, m: db.Ministry, viewerId: number) {
  const text = `⛪ ${m.name}\n\n${await summary(bot.api, m, viewerId)}\n👥 Admins: ${m.admin_user_ids.length}\n📬 Open requests: ${db.countOpenRequests(m.id)}`;
  const reply_markup = new InlineKeyboard()
    .text("🔗 Share link", `mg:${m.id}:link`).text("👥 Invite an admin", `mg:${m.id}:inv`).row()
    .text("🙏 Who prays", `mg:${m.id}:who`).text("📣 Who can ask", `mg:${m.id}:src`);
  return { text, reply_markup };
}

async function showManage(bot: Bot, ctx: Context): Promise<void> {
  const mine = db.listAdminMinistries(ctx.from!.id);
  if (mine.length === 0) {
    await ctx.reply("You don't run any prayer ministries yet.", {
      reply_markup: new InlineKeyboard().text("⛪ Set one up", "wel:setup"),
    });
  } else if (mine.length === 1) {
    const p = await panel(bot, mine[0]!, ctx.from!.id);
    await ctx.reply(p.text, { reply_markup: p.reply_markup });
  } else {
    const kb = new InlineKeyboard();
    for (const m of mine) kb.text(`⛪ ${m.name}`, `mg:${m.id}`).row();
    kb.text("➕ Set up another", "wel:setup");
    await ctx.reply("Which ministry?", { reply_markup: kb });
  }
}

// ---------- registration ----------

export function registerSetup(bot: Bot): {
  /** Bare /start in a DM. */
  welcome: (ctx: Context) => Promise<void>;
  /** /start <payload> in a group, from an add-to-group link. */
  groupStart: (ctx: Context, role: Role, ministryId: number) => Promise<void>;
  /** /start a_<token> in a DM. */
  acceptInvite: (ctx: Context, token: string) => Promise<void>;
  /** Wizard text input. Returns true if handled. */
  onText: (ctx: Context, state: db.UserState | null, text: string) => Promise<boolean>;
} {
  function adminMinistry(userId: number, ministryId: number): db.Ministry | null {
    const m = db.getMinistry(ministryId);
    return m?.admin_user_ids.includes(userId) ? m : null;
  }

  async function startWizard(ctx: Context) {
    db.setState(ctx.from!.id, { step: "setup_name" });
    await ctx.reply("Let's set up prayer for your community. It takes about a minute. ⛪\n\nStep 1 of 3 · What should I call your prayer ministry?\n\nFor example \"St Mary's Intercessors\" or \"Pray with Anselm\".");
  }

  bot.command("setup", async (ctx) => {
    if (ctx.chat.type !== "private") return ctx.reply("DM me /setup to get started.");
    await startWizard(ctx);
  });
  bot.command("manage", async (ctx) => {
    if (ctx.chat.type !== "private") return ctx.reply("DM me /manage.");
    await showManage(bot, ctx);
  });

  bot.callbackQuery("wel:setup", async (ctx) => {
    await ctx.answerCallbackQuery();
    await startWizard(ctx);
  });
  bot.callbackQuery("wel:need", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "🙏 Requests go to a specific prayer team, so you need that team's link.\n\n" +
      "Look for a 🙏 Request prayer button in your church's channel or group, or ask the leader for the link. Tapping it brings you back here to write your request privately.\n\n" +
      "Already sent one? /myrequests shows it.");
  });

  bot.callbackQuery(/^w:(me|ig|rc|rg|rl):(\d+):([01])$/, async (ctx) => {
    const [, action, id, w] = ctx.match;
    const m = adminMinistry(ctx.from.id, Number(id));
    if (!m) return ctx.answerCallbackQuery("You're not an admin of that ministry.");
    const wizard = w === "1";
    await ctx.answerCallbackQuery();

    if (action === "me") {
      db.setIntercessorChat(m.id, ctx.from.id);
      db.clearState(ctx.from.id);
      await ctx.editMessageText("✅ Requests will come to this chat. You'll get 🙏 I prayed and ✉️ buttons on each one.");
      if (wizard) {
        const step = whereFromStep(m, true);
        await ctx.reply(step.text, { reply_markup: step.reply_markup });
      }
      return;
    }
    if (action === "rl") {
      db.setRequestorChat(m.id, null);
      db.clearState(ctx.from.id);
      await ctx.editMessageText("✅ Anyone with your link can send requests.");
      if (wizard) await finishWizard(bot, ctx.chat!.id, m);
      else await sendShareKit(bot, ctx.chat!.id, m);
      return;
    }

    const role: Role = action === "ig" ? "intercessor" : "requestor";
    db.setState(ctx.from.id, { step: "setup_await_chat", ministryId: m.id, role, wizard });
    const step = action === "ig" ? intercessorGroupStep(bot, m, wizard)
      : action === "rc" ? channelStep(bot, m, wizard)
      : requestorGroupStep(bot, m, wizard);
    await ctx.editMessageText(step.text, { reply_markup: step.reply_markup });
  });

  bot.callbackQuery(/^mg:(\d+)(?::(link|inv|who|src))?$/, async (ctx) => {
    const [, id, action] = ctx.match;
    const m = adminMinistry(ctx.from.id, Number(id));
    if (!m) return ctx.answerCallbackQuery("You're not an admin of that ministry.");
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat!.id;
    if (!action) {
      const p = await panel(bot, m, ctx.from.id);
      return void (await ctx.editMessageText(p.text, { reply_markup: p.reply_markup }));
    }
    if (action === "link") return sendShareKit(bot, chatId, m);
    if (action === "inv") {
      const token = db.createInvite(m.id, ctx.from.id);
      return void (await ctx.reply(
        `👥 Send this link to the person you want to add as an admin of ${m.name}. It works once and expires in 7 days.\n\n${deepLink(bot, `a_${token}`)}\n\n` +
        "Admins review flagged requests and can change these settings."));
    }
    const step = action === "who" ? whoPraysStep(m, false) : whereFromStep(m, false);
    await ctx.reply(step.text, { reply_markup: step.reply_markup });
  });

  // Bot added to / removed from a group or channel.
  bot.on("my_chat_member", async (ctx) => {
    const { chat, from, old_chat_member: before, new_chat_member: after } = ctx.myChatMember;
    if (chat.type === "private") return;
    const isIn = (s: string) => s === "member" || s === "administrator" || s === "creator";
    if (!isIn(after.status)) {
      if (isIn(before.status)) await handleBotRemoved(ctx.api, chat.id);
      return;
    }
    if (isIn(before.status) && chat.type !== "channel") return; // e.g. promoted inside a group

    // Channels carry no payload, so match the adder's pending wizard step. Groups normally
    // link via the /start payload; this also covers adding the bot by hand.
    const state = db.getState(from.id);
    const m = state?.step === "setup_await_chat" ? adminMinistry(from.id, state.ministryId) : null;
    if (state?.step === "setup_await_chat" && m) {
      return linkChat(bot, m, state.role, chat, from, state.wizard);
    }
    if (chat.type === "channel") {
      await trySend(ctx.api, from.id,
        `I was added to "${chat.title}", but I'm not sure which ministry it's for. Use /manage → 📣 Who can ask → From my channel, then add me again.`);
    }
  });

  bot.on("message:migrate_to_chat_id", (ctx) => db.migrateChat(ctx.chat.id, ctx.message.migrate_to_chat_id));

  return {
    async welcome(ctx) {
      if (db.listAdminMinistries(ctx.from!.id).length > 0) return showManage(bot, ctx);
      await ctx.reply(
        "🙏 Welcome! I help communities pray for one another.\n\n" +
        "People send prayer requests privately, anonymously if they like. Intercessors pray, and can send back a word of encouragement. Requests are deleted once they close.",
        {
          reply_markup: new InlineKeyboard()
            .text("🙏 I need prayer", "wel:need").row()
            .text("⛪ Set up prayer for my community", "wel:setup"),
        });
    },

    async groupStart(ctx, role, ministryId) {
      const from = ctx.from!;
      if (from.id === GROUP_ANONYMOUS_BOT) {
        return void (await ctx.reply("You're posting as an anonymous admin, so I can't tell who you are. Turn off \"Remain anonymous\" in your admin settings for a moment, then tap the link again."));
      }
      const m = adminMinistry(from.id, ministryId);
      if (!m) return void (await ctx.reply("Only that ministry's admins can link this chat."));
      const state = db.getState(from.id);
      const wizard = state?.step === "setup_await_chat" && state.ministryId === m.id && state.wizard;
      const chat = ctx.chat!;
      await linkChat(bot, m, role, { id: chat.id, type: chat.type, title: "title" in chat ? chat.title : undefined }, from, wizard);
    },

    async acceptInvite(ctx, token) {
      const invite = db.consumeInvite(token);
      const m = invite && db.getMinistry(invite.ministryId);
      if (!invite || !m) return void (await ctx.reply("That invite link has expired or was already used. Ask for a new one."));
      db.addAdmin(m.id, ctx.from!.id);
      await trySend(ctx.api, invite.createdBy, `👥 ${fullName(ctx.from!)} is now an admin of ${m.name}.`);
      await ctx.reply(`✅ You're now an admin of ${m.name}. Flagged requests will come to you here for review.`);
      const p = await panel(bot, db.getMinistry(m.id)!, ctx.from!.id);
      await ctx.reply(p.text, { reply_markup: p.reply_markup });
    },

    async onText(ctx, state, text) {
      if (state?.step !== "setup_name") return false;
      if (text.length < 2 || text.length > 80) {
        await ctx.reply("Please send a name between 2 and 80 characters.");
        return true;
      }
      db.clearState(ctx.from!.id);
      const m = db.createMinistry(text, ctx.from!.id, ctx.from!.id);
      const step = whoPraysStep(m, true);
      await ctx.reply(`✅ Created ${m.name}.`);
      await ctx.reply(step.text, { reply_markup: step.reply_markup });
      return true;
    },
  };
}
