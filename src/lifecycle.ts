// Pure request-lifecycle rules. No Telegram or database imports, so it is unit-testable.

export type RequestStatus = "pending_review" | "open" | "closed" | "rejected";
export type CloseMode = "at_time" | "until_closed" | "on_first_prayer";

export const EXPIRY_PRESETS = {
  "1d": { label: "1 day", ms: 24 * 60 * 60 * 1000 },
  "1w": { label: "1 week", ms: 7 * 24 * 60 * 60 * 1000 },
  "1m": { label: "1 month", ms: 30 * 24 * 60 * 60 * 1000 },
  until_closed: { label: "Until I close it", ms: null },
  first_prayer: { label: "Once someone prays", ms: null },
} as const;
export type ExpiryPreset = keyof typeof EXPIRY_PRESETS;

export const MAX_REQUEST_LENGTH = 1000;
export const MAX_MESSAGE_LENGTH = 2000;

export function isExpiryPreset(value: string): value is ExpiryPreset {
  return Object.hasOwn(EXPIRY_PRESETS, value);
}

export function resolveExpiry(
  preset: ExpiryPreset,
  now: Date,
): { closeMode: CloseMode; expiresAt: Date | null } {
  if (preset === "until_closed") return { closeMode: "until_closed", expiresAt: null };
  if (preset === "first_prayer") return { closeMode: "on_first_prayer", expiresAt: null };
  return { closeMode: "at_time", expiresAt: new Date(now.getTime() + EXPIRY_PRESETS[preset].ms) };
}

export interface RequestLike {
  status: RequestStatus;
  expires_at: Date | null;
}

/** Expiry is enforced at read time; the cron only cleans up, so its schedule doesn't affect correctness. */
export function isAcceptingPrayers(req: RequestLike, now: Date): boolean {
  return req.status === "open" && (req.expires_at === null || req.expires_at > now);
}

export function closesAfterPrayer(req: { close_mode: CloseMode }): boolean {
  return req.close_mode === "on_first_prayer";
}

export type ModerationResult =
  | { ok: true; flagged: boolean; reason: string }
  | { ok: false; error: string };

/** Fail closed: anything other than a clean verdict goes to a human. */
export function routeAfterModeration(result: ModerationResult): "publish" | "review" {
  return result.ok && !result.flagged ? "publish" : "review";
}

export type StartPayload = { kind: "request"; ministryId: number } | { kind: "reply"; requestId: number };

export function parseStartPayload(payload: string | undefined): StartPayload | null {
  const m = /^(m|r)_(\d{1,15})$/.exec(payload ?? "");
  if (!m) return null;
  const id = Number(m[2]);
  return m[1] === "m" ? { kind: "request", ministryId: id } : { kind: "reply", requestId: id };
}

export function requesterLabel(req: { is_anonymous: boolean; display_name: string | null }): string {
  return req.is_anonymous || !req.display_name ? "Anonymous" : req.display_name;
}

function expiryLabel(req: { close_mode: CloseMode; expires_at: Date | null }): string {
  if (req.close_mode === "on_first_prayer") return "closes after the first prayer";
  if (req.close_mode === "until_closed" || !req.expires_at) return "open until the requester closes it";
  return `until ${req.expires_at.toISOString().slice(0, 10)}`;
}

/** Text of the post intercessors see. Never includes identity when anonymous. */
export function formatIntercessorPost(req: {
  id: number;
  is_anonymous: boolean;
  display_name: string | null;
  text: string | null;
  close_mode: CloseMode;
  expires_at: Date | null;
}): string {
  return [
    `🙏 Prayer request #${req.id}`,
    `From: ${requesterLabel(req)}`,
    `Open: ${expiryLabel(req)}`,
    "",
    req.text ?? "",
  ].join("\n");
}
