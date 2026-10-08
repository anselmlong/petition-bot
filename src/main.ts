import { createBot, endRequest } from "./bot.ts";
import * as db from "./db.ts";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing env var TELEGRAM_BOT_TOKEN");
if (!process.env.TYPESAFE_API_KEY) console.warn("TYPESAFE_API_KEY not set: every request will go to admin review.");

db.openDb(process.env.DATABASE_PATH || "data/petition.db");
const bot = createBot(token);

// Expiry is enforced whenever anyone interacts with a request; this sweep just closes the
// intercessor post, tells the requester, and purges content.
async function sweep() {
  for (const id of db.listExpiredOpenRequestIds()) await endRequest(bot.api, id, "expired");
  db.pruneStaleState();
}
const timer = setInterval(() => sweep().catch((err) => console.error("sweep failed", err)), 15 * 60 * 1000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(timer);
    void bot.stop();
  });
}

await sweep();
await bot.api.setMyCommands([
  { command: "myrequests", description: "See, close or delete your prayer requests" },
  { command: "cancel", description: "Stop what you're typing" },
  { command: "help", description: "How this bot works" },
]);
await bot.start({
  allowed_updates: ["message", "callback_query"],
  onStart: (me) => console.log(`@${me.username} polling`),
});
