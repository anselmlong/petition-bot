import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { CloseMode, RequestStatus } from "./lifecycle.js";

let client: NeonQueryFunction<false, false> | undefined;
function sql(strings: TemplateStringsArray, ...values: unknown[]) {
  client ??= neon(requireEnv("DATABASE_URL"));
  return client(strings, ...values) as Promise<Record<string, any>[]>;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

// Postgres BIGINT arrives as a string over the Neon HTTP driver; telegram ids fit in a JS number.
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const date = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string));

export interface Ministry {
  id: number;
  name: string;
  intercessor_chat_id: number;
  requestor_chat_id: number | null;
  admin_user_ids: number[];
}

export interface PrayerRequest {
  id: number;
  ministry_id: number;
  requester_tg_id: number;
  is_anonymous: boolean;
  display_name: string | null;
  text: string | null;
  status: RequestStatus;
  close_mode: CloseMode;
  expires_at: Date | null;
  moderation_reason: string | null;
  intercessor_message_id: number | null;
  created_at: Date;
}

function toMinistry(r: Record<string, any>): Ministry {
  return {
    id: Number(r.id),
    name: r.name,
    intercessor_chat_id: Number(r.intercessor_chat_id),
    requestor_chat_id: num(r.requestor_chat_id),
    admin_user_ids: (r.admin_user_ids as unknown[]).map(Number),
  };
}

function toRequest(r: Record<string, any>): PrayerRequest {
  return {
    id: Number(r.id),
    ministry_id: Number(r.ministry_id),
    requester_tg_id: Number(r.requester_tg_id),
    is_anonymous: r.is_anonymous,
    display_name: r.display_name,
    text: r.text,
    status: r.status,
    close_mode: r.close_mode,
    expires_at: date(r.expires_at),
    moderation_reason: r.moderation_reason,
    intercessor_message_id: num(r.intercessor_message_id),
    created_at: date(r.created_at)!,
  };
}

// ---- updates ----

/** Returns false if this update was already handled (Telegram retry). */
export async function claimUpdate(updateId: number): Promise<boolean> {
  const rows = await sql`
    INSERT INTO processed_updates (update_id) VALUES (${updateId})
    ON CONFLICT DO NOTHING RETURNING update_id`;
  return rows.length > 0;
}

// ---- user state ----

export type UserState =
  | { step: "request_text"; ministryId: number }
  | { step: "request_anon"; ministryId: number; text: string }
  | { step: "request_expiry"; ministryId: number; text: string; anonymous: boolean }
  | { step: "reply_text"; requestId: number };

export async function getState(userId: number): Promise<UserState | null> {
  const rows = await sql`SELECT state FROM user_state WHERE tg_user_id = ${userId}`;
  return (rows[0]?.state as UserState) ?? null;
}

export async function setState(userId: number, state: UserState): Promise<void> {
  await sql`
    INSERT INTO user_state (tg_user_id, state) VALUES (${userId}, ${JSON.stringify(state)})
    ON CONFLICT (tg_user_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`;
}

export async function clearState(userId: number): Promise<void> {
  await sql`DELETE FROM user_state WHERE tg_user_id = ${userId}`;
}

// ---- ministries ----

export async function createMinistry(name: string, intercessorChatId: number, adminId: number): Promise<Ministry> {
  const rows = await sql`
    INSERT INTO ministries (name, intercessor_chat_id, admin_user_ids)
    VALUES (${name}, ${intercessorChatId}, ${[adminId]}) RETURNING *`;
  return toMinistry(rows[0]!);
}

export async function getMinistry(id: number): Promise<Ministry | null> {
  const rows = await sql`SELECT * FROM ministries WHERE id = ${id}`;
  return rows[0] ? toMinistry(rows[0]) : null;
}

export async function listAdminMinistries(userId: number): Promise<Ministry[]> {
  const rows = await sql`SELECT * FROM ministries WHERE ${userId} = ANY(admin_user_ids) ORDER BY id`;
  return rows.map(toMinistry);
}

export async function setIntercessorChat(ministryId: number, chatId: number): Promise<void> {
  await sql`UPDATE ministries SET intercessor_chat_id = ${chatId} WHERE id = ${ministryId}`;
}

export async function setRequestorChat(ministryId: number, chatId: number | null): Promise<void> {
  await sql`UPDATE ministries SET requestor_chat_id = ${chatId} WHERE id = ${ministryId}`;
}

export async function addAdmin(ministryId: number, userId: number): Promise<void> {
  await sql`
    UPDATE ministries SET admin_user_ids = array_append(admin_user_ids, ${userId}::bigint)
    WHERE id = ${ministryId} AND NOT (${userId} = ANY(admin_user_ids))`;
}

// ---- bans ----

export async function isBanned(ministryId: number, userId: number): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM bans WHERE ministry_id = ${ministryId} AND tg_user_id = ${userId}`;
  return rows.length > 0;
}

export async function ban(ministryId: number, userId: number): Promise<void> {
  await sql`INSERT INTO bans (ministry_id, tg_user_id) VALUES (${ministryId}, ${userId}) ON CONFLICT DO NOTHING`;
}

// ---- requests ----

export async function createRequest(r: {
  ministryId: number;
  requesterId: number;
  anonymous: boolean;
  displayName: string | null;
  text: string;
  closeMode: CloseMode;
  expiresAt: Date | null;
}): Promise<PrayerRequest> {
  const rows = await sql`
    INSERT INTO requests (ministry_id, requester_tg_id, is_anonymous, display_name, text, status, close_mode, expires_at)
    VALUES (${r.ministryId}, ${r.requesterId}, ${r.anonymous}, ${r.displayName}, ${r.text},
            'pending_review', ${r.closeMode}, ${r.expiresAt?.toISOString() ?? null})
    RETURNING *`;
  return toRequest(rows[0]!);
}

export async function getRequest(id: number): Promise<PrayerRequest | null> {
  const rows = await sql`SELECT * FROM requests WHERE id = ${id}`;
  return rows[0] ? toRequest(rows[0]) : null;
}

export async function listActiveRequestsFor(userId: number): Promise<PrayerRequest[]> {
  const rows = await sql`
    SELECT * FROM requests WHERE requester_tg_id = ${userId} AND status IN ('pending_review', 'open')
    ORDER BY id DESC LIMIT 20`;
  return rows.map(toRequest);
}

export async function setModerationReason(id: number, reason: string): Promise<void> {
  await sql`UPDATE requests SET moderation_reason = ${reason} WHERE id = ${id}`;
}

/** Atomic pending_review → open. Returns null if someone else already decided. */
export async function publishRequest(id: number): Promise<PrayerRequest | null> {
  const rows = await sql`UPDATE requests SET status = 'open' WHERE id = ${id} AND status = 'pending_review' RETURNING *`;
  return rows[0] ? toRequest(rows[0]) : null;
}

export async function setIntercessorMessage(id: number, messageId: number): Promise<void> {
  await sql`UPDATE requests SET intercessor_message_id = ${messageId} WHERE id = ${id}`;
}

/**
 * Atomically move an active request to a terminal status and purge its content, leaving a
 * tombstone. Returns the pre-purge row so the caller can notify/clean up, or null if it was
 * already terminal (so concurrent closers can't both act).
 */
export async function finalizeRequest(id: number, status: "closed" | "rejected"): Promise<PrayerRequest | null> {
  const rows = await sql`
    WITH old AS (SELECT * FROM requests WHERE id = ${id} FOR UPDATE)
    UPDATE requests r SET status = ${status}, closed_at = now(), text = NULL, display_name = NULL
    FROM old WHERE r.id = old.id AND old.status IN ('pending_review', 'open')
    RETURNING old.*`;
  if (!rows[0]) return null;
  await sql`DELETE FROM prayers WHERE request_id = ${id}`;
  return toRequest(rows[0]);
}

export async function listExpiredOpenRequestIds(): Promise<number[]> {
  const rows = await sql`SELECT id FROM requests WHERE status = 'open' AND expires_at < now() LIMIT 500`;
  return rows.map((r) => Number(r.id));
}

// ---- prayers ----

export async function recordPrayer(requestId: number, intercessorId: number, message: string | null): Promise<number> {
  const rows = await sql`
    INSERT INTO prayers (request_id, intercessor_tg_id, message) VALUES (${requestId}, ${intercessorId}, ${message})
    RETURNING id`;
  return Number(rows[0]!.id);
}

export async function markPrayerDelivered(prayerId: number): Promise<void> {
  // Message content isn't needed once the requester has it.
  await sql`UPDATE prayers SET delivered_at = now(), message = NULL WHERE id = ${prayerId}`;
}

export async function countPrayers(requestId: number): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS n FROM prayers WHERE request_id = ${requestId}`;
  return Number(rows[0]!.n);
}

// ---- housekeeping ----

export async function pruneEphemeral(): Promise<void> {
  await sql`DELETE FROM processed_updates WHERE created_at < now() - interval '2 days'`;
  await sql`DELETE FROM user_state WHERE updated_at < now() - interval '1 day'`;
}
