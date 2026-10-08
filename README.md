# Petition Bot 🙏

A Telegram bot for requesting intercessory prayer in a centralised, trackable way.

- **Requestors** send a private request (anonymous or named), choose how long it stays open, and are notified each time someone prays — including any message the intercessor felt led to send back.
- **Intercessors** see requests in their DM or group, tap **🙏 I prayed**, or **✉️ Pray + send a message**.
- **Admins** review anything the AI screen flags, and can approve, reject, or ban.

## How it works

```
requestor ──DM──▶ bot ──AI screen──┬─ clean ───▶ intercessor chat (DM or group)
  (deep link from                  └─ flagged ─▶ admin DMs: Approve / Reject / Ban
   channel/group)                                        │
                                   ◀── "X prayed" / message ┘
```

**Ministry** = one place requests go. Two setups:

| Setup | Intercessor chat | Requestors |
|---|---|---|
| Individual | The intercessor's DM with the bot | Members of their channel, via a deep link |
| Group | A group of intercessors | Members of a requestors' group, via a deep link |

Requests are always submitted in a **private DM** with the bot, so nobody else in the channel or group sees who asked.

### Privacy and data lifecycle

- **Anonymous** requests hide the requester from intercessors. The Telegram ID is kept so replies can be routed back, and admins can see who sent a request when it's flagged for review (needed for abuse handling).
- **Expiry options:** 1 day, 1 week, 1 month, until I close it, or once someone prays.
- When a request closes, expires or is deleted, its text and name are **purged**, along with all prayers and messages. Only an id, status and timestamps remain. Intercessor messages are deleted as soon as they're delivered.
- Requestors can `/myrequests` → **Close** or **Delete** at any time. Admins can **🗑 Remove** a post from the intercessor chat.

### Moderation

Each request is screened by an LLM (via Vercel AI Gateway, default `anthropic/claude-haiku-5.5`). The screen is tuned to *not* flag heavy-but-genuine topics (grief, illness, abuse, mental health). It flags spam, harassment, explicit content, doxxing, off-topic messages, and imminent-danger cases. Flagged requests go to the ministry admins. **If the AI call fails, the request goes to human review rather than straight through.**

## Commands

| Who | Command |
|---|---|
| Anyone | `/myrequests`, `/cancel`, `/help` |
| Admin (DM) | `/newministry <name>`, `/link <id>`, `/ministries` |
| Admin (in group) | `/linkintercessors <id>`, `/linkrequestors <id>`, reply + `/addadmin <id>` |
| Admin (DM, channels) | `/linkrequestors <id> @channel` (bot must be a channel admin) |

## Setup

1. **Create the bot**: message [@BotFather](https://t.me/BotFather) → `/newbot`, copy the token. Leave group privacy mode **on**, since the bot only needs commands and buttons.
2. **Provision**: a Postgres database (e.g. Neon via the Vercel Marketplace) and a Vercel project.
3. **Env vars**: see [`.env.example`](.env.example). Generate secrets with `openssl rand -hex 32`.
4. **Migrate**: `npm run db:migrate` (reads `.env.local`).
5. **Deploy** to Vercel, then point Telegram at it:
   ```sh
   npm run webhook:set -- https://<your-deployment>.vercel.app
   ```
6. **Create a ministry**: DM the bot `/newministry Pastor Jo's Prayer Line`, and share the link it gives you.
   - Group of intercessors: add the bot to the group and run `/linkintercessors <id>` there.
   - Restrict who can submit: `/linkrequestors <id>` in the requestors' group, or `/linkrequestors <id> @channel` in a DM. For channels, the bot must be an admin.

## Development

```sh
npm install
npm test         # lifecycle unit tests
npm run typecheck
```

Layout:

- `api/telegram.ts`: the webhook. It verifies the secret header, acks immediately, then handles the update in `waitUntil`, deduping on `update_id`.
- `api/cron.ts`: the daily cleanup for expired requests. Expiry itself is enforced at tap time.
- `src/lifecycle.ts`: pure rules (expiry, routing, formatting), unit-tested.
- `src/bot.ts`: Telegram handlers.
- `src/db.ts`: queries.
- `schema.sql`: the database schema.

## License

MIT
