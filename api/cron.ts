import { Api } from "grammy";
import { endRequest } from "../src/bot.js";
import { listExpiredOpenRequestIds, pruneEphemeral, requireEnv } from "../src/db.js";

// Expiry is already enforced when anyone interacts with a request; this just tidies up
// (closes the post, notifies the requester, purges content).
export async function GET(request: Request): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${requireEnv("CRON_SECRET")}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const api = new Api(requireEnv("TELEGRAM_BOT_TOKEN"));
  const ids = await listExpiredOpenRequestIds();
  for (const id of ids) await endRequest(api, id, "expired");
  await pruneEphemeral();
  return Response.json({ expired: ids.length });
}
