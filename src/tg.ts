// Small Telegram helpers shared by the request flow and the setup wizard.
import { GrammyError, type Api, type Bot } from "grammy";
import type { User } from "grammy/types";
import * as db from "./db.ts";

export function fullName(u: User): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
  return u.username ? `${name} (@${u.username})` : name;
}

export function deepLink(bot: Bot, payload: string): string {
  return `https://t.me/${bot.botInfo.username}?start=${payload}`;
}

/** Opens Telegram's "pick a group" dialog, adds the bot, then sends `/start@bot <payload>` in that group. */
export function addToGroupLink(bot: Bot, payload: string): string {
  return `https://t.me/${bot.botInfo.username}?startgroup=${payload}`;
}

/** Opens Telegram's "pick a channel" dialog and makes the bot an admin that can post. No payload is possible. */
export function addToChannelLink(bot: Bot): string {
  return `https://t.me/${bot.botInfo.username}?startchannel&admin=post_messages`;
}

export async function isMemberOf(api: Api, chatId: number, userId: number): Promise<boolean> {
  if (chatId === userId) return true;
  if (chatId > 0) return false; // another person's DM
  try {
    const m = await api.getChatMember(chatId, userId);
    return m.status === "creator" || m.status === "administrator" || m.status === "member" ||
      (m.status === "restricted" && m.is_member);
  } catch {
    return false;
  }
}

/** sendMessage that never throws. Follows a group → supergroup upgrade transparently. */
export async function trySend(api: Api, chatId: number, text: string, other?: Parameters<Api["sendMessage"]>[2]) {
  try {
    return await api.sendMessage(chatId, text, other);
  } catch (err) {
    const migratedTo = err instanceof GrammyError ? err.parameters.migrate_to_chat_id : undefined;
    if (migratedTo) {
      db.migrateChat(chatId, migratedTo);
      return trySend(api, migratedTo, text, other);
    }
    console.error(`sendMessage to ${chatId} failed:`, err instanceof GrammyError ? err.description : err);
    return null;
  }
}
