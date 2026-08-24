// Supabase Edge Function: market-calendar-sync
//
// Deploy via GitHub Actions (see .github/workflows/deploy-market-calendar-function.yml),
// NOT the dashboard editor — this function needs verify_jwt = false (set in
// supabase/config.toml), which is only configurable through the CLI, not the
// dashboard's "create new function" screen.
//
// Pulls Alpaca's trading calendar and upserts it into market_calendar_days so
// the frontend can exclude weekends/holidays from analytics without calling
// Alpaca directly (and without exposing Alpaca keys to the browser).
//
// Since verify_jwt is off, the platform gateway lets any request through
// without checking for a user JWT. This function checks its own shared secret
// instead (Supabase's documented pattern for cron/service-to-service calls —
// see https://supabase.com/docs/guides/functions/auth, "Service-to-service
// calls"). Anyone calling this function must send that secret in the `apikey`
// header, not `Authorization`.
//
// Set secrets first (Supabase dashboard > Edge Functions > Secrets, or
// `supabase secrets set` from CI):
//   ALPACA_KEY_ID=...
//   ALPACA_SECRET_KEY=...
//   ALPACA_API_BASE_URL=https://paper-api.alpaca.markets
//     (use https://api.alpaca.markets if you're using live keys; paper-api works
//      fine too since the calendar is the same for both — just match whichever
//      key pair you set above)
//   MARKET_SYNC_SHARED_SECRET=<a long random string you make up yourself>
//     Use the same value as the MARKET_SYNC_SHARED_SECRET GitHub Actions secret.
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the Edge
// Function runtime — you don't need to set those yourself. These are used
// only to talk to the database, and are unrelated to the apikey check above.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALPACA_KEY_ID = Deno.env.get("ALPACA_KEY_ID");
const ALPACA_SECRET_KEY = Deno.env.get("ALPACA_SECRET_KEY");
const ALPACA_API_BASE_URL = Deno.env.get("ALPACA_API_BASE_URL") || "https://api.alpaca.markets";

const MARKET_SYNC_SHARED_SECRET = Deno.env.get("MARKET_SYNC_SHARED_SECRET");

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function fmt(d: Date) {
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!MARKET_SYNC_SHARED_SECRET || req.headers.get("apikey") !== MARKET_SYNC_SHARED_SECRET) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!ALPACA_KEY_ID || !ALPACA_SECRET_KEY) {
    return new Response(JSON.stringify({ error: "ALPACA_KEY_ID / ALPACA_SECRET_KEY not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // ~400 days back covers the 90-day rolling windows plus the 30-vs-prior-30
    // trend comparisons with room to spare; 60 days forward means you won't need
    // to re-sync just because a new week arrived.
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 400);
    const end = new Date();
    end.setUTCDate(end.getUTCDate() + 60);

    const startStr = fmt(start);
    const endStr = fmt(end);

    const res = await fetch(`${ALPACA_API_BASE_URL}/v2/calendar?start=${startStr}&end=${endStr}`, {
      headers: {
        "APCA-API-KEY-ID": ALPACA_KEY_ID,
        "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      return new Response(JSON.stringify({ error: `Alpaca calendar fetch failed: ${errText}` }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const openDays: { date: string; open: string; close: string }[] = await res.json();
    const openMap = new Map(openDays.map((d) => [d.date, d]));

    // Write a row for every calendar date in range, not just open ones, so a
    // "closed" day is an explicit fact rather than just an absent row.
    const rows: { date: string; is_open: boolean; open_time: string | null; close_time: string | null }[] = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      const dateStr = fmt(cursor);
      const info = openMap.get(dateStr);
      rows.push({
        date: dateStr,
        is_open: !!info,
        open_time: info?.open ?? null,
        close_time: info?.close ?? null,
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    const batchSize = 500;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const { error } = await supabase.from("market_calendar_days").upsert(batch, { onConflict: "date" });
      if (error) throw error;
    }

    return new Response(JSON.stringify({ synced: rows.length, range: { start: startStr, end: endStr } }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
