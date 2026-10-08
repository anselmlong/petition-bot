// Points Telegram at the deployed webhook. Usage: npm run webhook:set -- https://your-app.vercel.app
const base = process.argv[2];
if (!base) throw new Error("Pass the deployment URL, e.g. npm run webhook:set -- https://petition-bot.vercel.app");

const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: `${base.replace(/\/$/, "")}/api/telegram`,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  }),
});
console.log(await res.json());
