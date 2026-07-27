import { jsonResponse } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  const secret = Deno.env.get("SCHEDULE_SECRET");
  if (secret && req.headers.get("x-schedule-secret") !== secret) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const supabase = serviceClient();
  const { data: settings } = await supabase.from("qbtime_settings").select("id,access_token,refresh_token").limit(1).maybeSingle();
  if (!settings) return jsonResponse({ skipped: true, reason: "QuickBooks Time is not configured" });
  if (!settings.access_token || !settings.refresh_token) {
    return jsonResponse({ skipped: true, reason: "QuickBooks Time authorization expired; reconnect required" });
  }

  const qbtimeUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/qbtime?action=sync`;
  const response = await fetch(qbtimeUrl, {
    method: "POST",
    headers: {
      "x-schedule-secret": secret || "",
      "Content-Type": "application/json",
    },
  });
  return jsonResponse({ status: response.status, data: await response.json().catch(() => ({})) });
});
