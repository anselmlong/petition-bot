import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CloseMode, RequestStatus } from "./lifecycle.ts";

const SCHEMA = `
-- A ministry is one intercessor "endpoint". Solo mode: intercessor_chat_id is the
-- intercessor's own DM with the bot. Group mode: it is the intercessors' group.
CREATE TABLE IF NOT EXISTS ministries (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,
  intercessor_chat_id INTEGER NOT NULL,
  -- Optional channel/group whose members may submit requests. NULL = anyone with the link.
  requestor_chat_id   INTEGER,
  created_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ministry_admins (
  ministry_id INTEGER NOT NULL REFERENCES ministries(id) ON DELETE CASCADE,
  tg_user_id  INTEGER NOT NULL,
  PRIMARY KEY (ministry_id, tg_user_id)
);

CREATE TABLE IF NOT EXISTS requests (
  id                     INTEGER PRIMARY KEY,
  ministry_id            INTEGER NOT NULL REFERENCES ministries(id) ON DELETE CASCADE,
  -- Needed to route prayers/messages back. Never shown to intercessors when is_anonymous.
  requester_tg_id        INTEGER NOT NULL,
  is_anonymous           INTEGER NOT NULL,
  -- Content columns are NULLed on close/expiry/delete; the row stays as a tombstone.
  display_name           TEXT,
  text                   TEXT,
  status                 TEXT NOT NULL CHECK (status IN ('pending_review', 'open', 'closed', 'rejected')),
  close_mode             TEXT NOT NULL CHECK (close_mode IN ('at_time', 'until_closed', 'on_first_prayer')),
  expires_at             INTEGER,
  moderation_reason      TEXT,
  intercessor_message_id INTEGER,
  created_at             INTEGER NOT NULL,
  closed_at              INTEGER
);
CREATE INDEX IF NOT EXISTS requests_status_expiry ON requests (status, expires_at);
CREATE INDEX IF NOT EXISTS requests_requester ON requests (requester_tg_id, status);

CREATE TABLE IF NOT EXISTS prayers (
  id                INTEGER PRIMARY KEY,
  request_id        INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  intercessor_tg_id INTEGER NOT NULL,
  message           TEXT,
  delivered_at      INTEGER,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bans (
  ministry_id INTEGER NOT NULL REFERENCES ministries(id) ON DELETE CASCADE,
  tg_user_id  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (ministry_id, tg_user_id)
);

-- One pending multi-step DM flow per user.
CREATE TABLE IF NOT EXISTS user_state (
  tg_user_id INTEGER PRIMARY KEY,
  state      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

let conn: DatabaseSync | undefined;

/** Opens (and migrates) the database. Pass ":memory:" in tests. */
export function openDb(path: string): void {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  conn?.close();
  conn = new DatabaseSync(path);
  conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  conn.exec(SCHEMA);
}

function db(): DatabaseSync {
  if (!conn) throw new Error("openDb() not called");
  return conn;
}

type Row = Record<string, any>;
const all = (sql: string, ...params: any[]) => db().prepare(sql).all(...params) as Row[];
const get = (sql: string, ...params: any[]) => db().prepare(sql).get(...params) as Row | undefined;
const run = (sql: string, ...params: any[]) => db().prepare(sql).run(...params);
const now = () => Date.now();
const date = (v: unknown) => (v === null || v === undefined ? null : new Date(v as number));

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

function toMinistry(r: Row): Ministry {
  const admins = all("SELECT tg_user_id FROM ministry_admins WHERE ministry_id = ?", r.id);
  return {
    id: r.id,
    name: r.name,
    intercessor_chat_id: r.intercessor_chat_id,
    requestor_chat_id: r.requestor_chat_id,
    admin_user_ids: admins.map((a) => a.tg_user_id),
  };
}

function toRequest(r: Row): PrayerRequest {
  return {
    id: r.id,
    ministry_id: r.ministry_id,
    requester_tg_id: r.requester_tg_id,
    is_anonymous: r.is_anonymous === 1,
    display_name: r.display_name,
    text: r.text,
    status: r.status,
    close_mode: r.close_mode,
    expires_at: date(r.expires_at),
    moderation_reason: r.moderation_reason,
    intercessor_message_id: r.intercessor_message_id,
    created_at: date(r.created_at)!,
  };
}

// ---- user state ----

export type UserState =
  | { step: "request_text"; ministryId: number }
  | { step: "request_anon"; ministryId: number; text: string }
  | { step: "request_expiry"; ministryId: number; text: string; anonymous: boolean }
  | { step: "reply_text"; requestId: number };

export function getState(userId: number): UserState | null {
  const row = get("SELECT state FROM user_state WHERE tg_user_id = ?", userId);
  return row ? (JSON.parse(row.state) as UserState) : null;
}

export function setState(userId: number, state: UserState): void {
  run(
    `INSERT INTO user_state (tg_user_id, state, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (tg_user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
    userId, JSON.stringify(state), now(),
  );
}

export function clearState(userId: number): void {
  run("DELETE FROM user_state WHERE tg_user_id = ?", userId);
}

// ---- ministries ----

export function createMinistry(name: string, intercessorChatId: number, adminId: number): Ministry {
  const row = get(
    "INSERT INTO ministries (name, intercessor_chat_id, created_at) VALUES (?, ?, ?) RETURNING *",
    name, intercessorChatId, now(),
  )!;
  run("INSERT INTO ministry_admins (ministry_id, tg_user_id) VALUES (?, ?)", row.id, adminId);
  return toMinistry(row);
}

export function getMinistry(id: number): Ministry | null {
  const row = get("SELECT * FROM ministries WHERE id = ?", id);
  return row ? toMinistry(row) : null;
}

export function listAdminMinistries(userId: number): Ministry[] {
  return all(
    `SELECT m.* FROM ministries m JOIN ministry_admins a ON a.ministry_id = m.id
     WHERE a.tg_user_id = ? ORDER BY m.id`,
    userId,
  ).map(toMinistry);
}

export function setIntercessorChat(ministryId: number, chatId: number): void {
  run("UPDATE ministries SET intercessor_chat_id = ? WHERE id = ?", chatId, ministryId);
}

export function setRequestorChat(ministryId: number, chatId: number | null): void {
  run("UPDATE ministries SET requestor_chat_id = ? WHERE id = ?", chatId, ministryId);
}

export function addAdmin(ministryId: number, userId: number): void {
  run("INSERT OR IGNORE INTO ministry_admins (ministry_id, tg_user_id) VALUES (?, ?)", ministryId, userId);
}

// ---- bans ----

export function isBanned(ministryId: number, userId: number): boolean {
  return !!get("SELECT 1 FROM bans WHERE ministry_id = ? AND tg_user_id = ?", ministryId, userId);
}

export function ban(ministryId: number, userId: number): void {
  run("INSERT OR IGNORE INTO bans (ministry_id, tg_user_id, created_at) VALUES (?, ?, ?)", ministryId, userId, now());
}

// ---- requests ----

export function createRequest(r: {
  ministryId: number;
  requesterId: number;
  anonymous: boolean;
  displayName: string | null;
  text: string;
  closeMode: CloseMode;
  expiresAt: Date | null;
}): PrayerRequest {
  return toRequest(get(
    `INSERT INTO requests (ministry_id, requester_tg_id, is_anonymous, display_name, text, status, close_mode, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending_review', ?, ?, ?) RETURNING *`,
    r.ministryId, r.requesterId, r.anonymous ? 1 : 0, r.displayName, r.text, r.closeMode,
    r.expiresAt?.getTime() ?? null, now(),
  )!);
}

export function getRequest(id: number): PrayerRequest | null {
  const row = get("SELECT * FROM requests WHERE id = ?", id);
  return row ? toRequest(row) : null;
}

export function listActiveRequestsFor(userId: number): PrayerRequest[] {
  return all(
    `SELECT * FROM requests WHERE requester_tg_id = ? AND status IN ('pending_review', 'open')
     ORDER BY id DESC LIMIT 20`,
    userId,
  ).map(toRequest);
}

export function setModerationReason(id: number, reason: string): void {
  run("UPDATE requests SET moderation_reason = ? WHERE id = ?", reason, id);
}

/** pending_review → open. Returns null if someone else already decided. */
export function publishRequest(id: number): PrayerRequest | null {
  const row = get("UPDATE requests SET status = 'open' WHERE id = ? AND status = 'pending_review' RETURNING *", id);
  return row ? toRequest(row) : null;
}

export function setIntercessorMessage(id: number, messageId: number): void {
  run("UPDATE requests SET intercessor_message_id = ? WHERE id = ?", messageId, id);
}

/**
 * Moves an active request to a terminal status and purges its content (and all prayers),
 * leaving a tombstone. Returns the pre-purge row, or null if it was already terminal, so
 * concurrent closers can't both act. Synchronous, so nothing interleaves.
 */
export function finalizeRequest(id: number, status: "closed" | "rejected"): PrayerRequest | null {
  const row = get("SELECT * FROM requests WHERE id = ? AND status IN ('pending_review', 'open')", id);
  if (!row) return null;
  db().exec("BEGIN");
  try {
    run("UPDATE requests SET status = ?, closed_at = ?, text = NULL, display_name = NULL WHERE id = ?", status, now(), id);
    run("DELETE FROM prayers WHERE request_id = ?", id);
    db().exec("COMMIT");
  } catch (err) {
    db().exec("ROLLBACK");
    throw err;
  }
  return toRequest(row);
}

export function listExpiredOpenRequestIds(at = new Date()): number[] {
  return all("SELECT id FROM requests WHERE status = 'open' AND expires_at < ? LIMIT 500", at.getTime()).map((r) => r.id);
}

// ---- prayers ----

export function recordPrayer(requestId: number, intercessorId: number, message: string | null): number {
  return get(
    "INSERT INTO prayers (request_id, intercessor_tg_id, message, created_at) VALUES (?, ?, ?, ?) RETURNING id",
    requestId, intercessorId, message, now(),
  )!.id;
}

export function markPrayerDelivered(prayerId: number): void {
  // Message content isn't needed once the requester has it.
  run("UPDATE prayers SET delivered_at = ?, message = NULL WHERE id = ?", now(), prayerId);
}

export function countPrayers(requestId: number): number {
  return get("SELECT count(*) AS n FROM prayers WHERE request_id = ?", requestId)!.n;
}

// ---- housekeeping ----

export function pruneStaleState(): void {
  run("DELETE FROM user_state WHERE updated_at < ?", now() - 24 * 60 * 60 * 1000);
}
