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

Each request is screened by [TypeSafe Jev](https://docs.typesafe.ai), which answers yes/no questions with a probability. The bot asks six questions: spam, abusive, sexual, doxxing, not a real request, and someone in danger. Any answer at 50% or more sends the request to the ministry admins, along with which questions triggered. The questions target misuse, not heavy topics, so genuine requests about grief or illness pass. **If the API call fails, or the key isn't set, the request goes to human review rather than straight through.**

## Commands

| Who | Command |
|---|---|
| Anyone | `/myrequests`, `/cancel`, `/help` |
| Admin (DM) | `/newministry <name>`, `/link <id>`, `/ministries` |
| Admin (in group) | `/linkintercessors <id>`, `/linkrequestors <id>`, reply + `/addadmin <id>` |
| Admin (DM, channels) | `/linkrequestors <id> @channel` (bot must be a channel admin) |

## Setup

Runs as a single long-polling Node process with SQLite. No public URL, webhook or external database is needed.

1. **Create the bot**: message [@BotFather](https://t.me/BotFather) → `/newbot`, copy the token. Leave group privacy mode **on**, since the bot only needs commands and buttons.
2. Copy `.env.example` to `.env` and fill it in.
3. `npm ci --omit=dev && npm start`. This needs Node ≥ 22.18, which runs the TypeScript directly with no build step and has built-in SQLite.
4. **Create a ministry**: DM the bot `/newministry Pastor Jo's Prayer Line`, and share the link it gives you.
   - Group of intercessors: add the bot to the group and run `/linkintercessors <id>` there.
   - Restrict who can submit: `/linkrequestors <id>` in the requestors' group, or `/linkrequestors <id> @channel` in a DM. For channels, the bot must be an admin.

### Running on a server (systemd)

```sh
git clone https://github.com/anselmlong/petition-bot ~/petition-bot && cd ~/petition-bot
npm ci --omit=dev && $EDITOR .env
cp petition-bot.service ~/.config/systemd/user/ && systemctl --user daemon-reload
systemctl --user enable --now petition-bot
journalctl --user -u petition-bot -f
```

The database lives at `data/petition.db`. Back it up, and don't delete it.

## Development

```sh
npm install
npm test           # lifecycle, SQLite, moderation, and end-to-end handler tests (fake Telegram API)
npm run typecheck
npm run dev        # watch mode
```

Layout:

- `src/main.ts`: the entry point. It runs long polling and a 15-minute sweep that closes expired requests. Expiry itself is also enforced at tap time.
- `src/lifecycle.ts`: pure rules (expiry, routing, formatting).
- `src/bot.ts`: Telegram handlers.
- `src/db.ts`: the SQLite schema and queries (`node:sqlite`).
- `src/moderation.ts`: TypeSafe Jev screening.

## License

MIT
