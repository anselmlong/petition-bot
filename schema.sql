-- Idempotent: safe to run on every deploy via `npm run db:migrate`.

-- A ministry is one intercessor "endpoint". Solo mode: intercessor_chat_id is the
-- intercessor's own DM with the bot. Group mode: it is the intercessors' group.
CREATE TABLE IF NOT EXISTS ministries (
  id                  BIGSERIAL PRIMARY KEY,
  name                TEXT NOT NULL,
  intercessor_chat_id BIGINT NOT NULL,
  -- Optional channel/group whose members may submit requests. NULL = anyone with the link.
  requestor_chat_id   BIGINT,
  admin_user_ids      BIGINT[] NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS requests (
  id                      BIGSERIAL PRIMARY KEY,
  ministry_id             BIGINT NOT NULL REFERENCES ministries(id) ON DELETE CASCADE,
  -- Needed to route prayers/messages back. Never shown to intercessors when is_anonymous.
  requester_tg_id         BIGINT NOT NULL,
  is_anonymous            BOOLEAN NOT NULL,
  -- Content columns are NULLed on close/expiry/delete; the row stays as a tombstone.
  display_name            TEXT,
  text                    TEXT,
  status                  TEXT NOT NULL CHECK (status IN ('pending_review', 'open', 'closed', 'rejected')),
  close_mode              TEXT NOT NULL CHECK (close_mode IN ('at_time', 'until_closed', 'on_first_prayer')),
  expires_at              TIMESTAMPTZ,
  moderation_reason       TEXT,
  intercessor_message_id  BIGINT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at               TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS requests_open_expiry ON requests (expires_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS requests_requester ON requests (requester_tg_id, status);

CREATE TABLE IF NOT EXISTS prayers (
  id                BIGSERIAL PRIMARY KEY,
  request_id        BIGINT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  intercessor_tg_id BIGINT NOT NULL,
  message           TEXT,
  delivered_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bans (
  ministry_id BIGINT NOT NULL REFERENCES ministries(id) ON DELETE CASCADE,
  tg_user_id  BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ministry_id, tg_user_id)
);

-- One pending multi-step DM flow per user (webhooks are stateless).
CREATE TABLE IF NOT EXISTS user_state (
  tg_user_id BIGINT PRIMARY KEY,
  state      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Telegram retries webhooks it thinks failed; dedupe on update_id.
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id  BIGINT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
