// Standalone session-reminder notifier — Cloudflare Worker
//
// Fully independent of Supabase Edge Functions and pg_cron. Its only
// connection to the Trade Journal app is a read-only check of today's
// trading_days row (and market_calendar_days) via Supabase's REST API,
// to see whether today is a real trading day that needs a reminder, and
// whether the pre-session / post-session sections have been filled in.
//
// DEPLOY (browser-only, via the Cloudflare dashboard):
//   1. dash.cloudflare.com -> Workers & Pages -> Create -> Create Worker
//   2. Name it (e.g. "session-reminder"), then click "Edit code" and paste
//      this entire file in, replacing the starter template. Save & Deploy.
//   3. Settings -> Variables -> add these as *encrypted* secrets:
//        SUPABASE_URL               e.g. https://YOUR_PROJECT_REF.supabase.co
//        SUPABASE_SERVICE_ROLE_KEY  (Supabase Dashboard > Settings > API > service_role key)
//        SUPABASE_USER_ID           your auth.users.id (Supabase Dashboard > Authentication > Users)
//        PUSHOVER_USER_KEY
//        PUSHOVER_API_TOKEN
//   4. Settings -> Bindings -> KV Namespace -> bind an existing/new
//      namespace to variable name REMINDER_KV.
//   5. Settings -> Trigger Events -> Cron Triggers -> Add: */5 * * * *
//
// SECURITY NOTE: this Worker holds your Supabase service role key, which
// bypasses Row Level Security entirely. Keep it only as an encrypted
// Cloudflare secret, never in code or logs.

const PRE_HOUR = 8;
const PRE_MINUTE_WINDOW = [45, 49]; // fires once between 8:45–8:49am ET
const POST_HOUR = 20;
const POST_MINUTE_WINDOW = [0, 4]; // fires once between 8:00–8:04pm ET

function nowInET() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    dateStr: `${get("year")}-${get("month")}-${get("day")}`,
    hour: parseInt(get("hour"), 10),
    minute: parseInt(get("minute"), 10),
    weekday: get("weekday"), // "Mon", "Tue", ... "Sat", "Sun"
  };
}

async function supabaseGet(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase REST error: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getTodayTradingDay(env, dateStr) {
  const rows = await supabaseGet(
    env,
    `trading_days?entry_date=eq.${dateStr}&user_id=eq.${env.SUPABASE_USER_ID}` +
      `&select=pre_setups,pre_mental_state,pre_notes,pre_max_loss,plan_followed,on_vacation`
  );
  return rows[0] || null;
}

async function getMarketCalendarDay(env, dateStr) {
  const rows = await supabaseGet(env, `market_calendar_days?date=eq.${dateStr}&select=is_open`);
  return rows[0] || null; // null = no data synced for this date yet
}

async function sendPushover(env, title, message) {
  const body = new URLSearchParams({
    token: env.PUSHOVER_API_TOKEN,
    user: env.PUSHOVER_USER_KEY,
    title,
    message,
  });
  const res = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Pushover error: ${res.status} ${await res.text()}`);
}

function preSessionIsEmpty(row) {
  if (!row) return true; // no row yet today = definitely not filled in
  return !row.pre_setups && !row.pre_mental_state && !row.pre_notes && row.pre_max_loss == null;
}

function postSessionIsEmpty(row) {
  if (!row) return true;
  return row.plan_followed === null || row.plan_followed === undefined;
}

async function alreadySent(env, key) {
  return (await env.REMINDER_KV.get(key)) !== null;
}

async function markSent(env, key) {
  await env.REMINDER_KV.put(key, "sent", { expirationTtl: 72000 }); // 20h self-clean
}

// Returns { skip: true, reason } or { skip: false, row, calendarDay }
async function evaluateDay(env, dateStr, weekday) {
  if (weekday === "Sat" || weekday === "Sun") {
    return { skip: true, reason: `weekend (${weekday})` };
  }

  const calendarDay = await getMarketCalendarDay(env, dateStr);
  if (calendarDay && calendarDay.is_open === false) {
    return { skip: true, reason: "market holiday (market_calendar_days.is_open = false)" };
  }

  const row = await getTodayTradingDay(env, dateStr);
  if (row && row.on_vacation === true) {
    return { skip: true, reason: "on_vacation = true" };
  }

  return { skip: false, row, calendarDay };
}

async function handleScheduled(env) {
  const { dateStr, hour, minute, weekday } = nowInET();
  const inWindow = (h, [lo, hi]) => hour === h && minute >= lo && minute <= hi;

  const preDue = inWindow(PRE_HOUR, PRE_MINUTE_WINDOW);
  const postDue = inWindow(POST_HOUR, POST_MINUTE_WINDOW);
  if (!preDue && !postDue) return;

  const { skip, reason, row } = await evaluateDay(env, dateStr, weekday);
  if (skip) return; // no DB write, no Pushover — today doesn't need a reminder at all

  if (preDue) {
    const key = `pre-${dateStr}`;
    if (!(await alreadySent(env, key))) {
      if (preSessionIsEmpty(row)) {
        await sendPushover(env, "Trade Journal: Pre-Session", "Pre-Session Plan not filled out yet — market opens today.");
      }
      await markSent(env, key);
    }
  }

  if (postDue) {
    const key = `post-${dateStr}`;
    if (!(await alreadySent(env, key))) {
      if (postSessionIsEmpty(row)) {
        await sendPushover(env, "Trade Journal: Post-Session", "Post-Session Review not filled out yet.");
      }
      await markSent(env, key);
    }
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },

  // Manual test hook: visiting the Worker's URL runs the same day-evaluation
  // logic (weekend/holiday/vacation) immediately, but ignores the specific
  // pre/post time window so you can verify behavior without waiting.
  async fetch(request, env, ctx) {
    const { dateStr, weekday } = nowInET();
    const evalResult = await evaluateDay(env, dateStr, weekday);

    if (evalResult.skip) {
      return new Response(
        JSON.stringify({ dateStr, weekday, skipped: true, reason: evalResult.reason }, null, 2),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    const { row } = evalResult;
    const preEmpty = preSessionIsEmpty(row);
    const postEmpty = postSessionIsEmpty(row);

    if (preEmpty) await sendPushover(env, "Trade Journal: Pre-Session (test)", "Pre-Session Plan not filled out yet — market opens today.");
    if (postEmpty) await sendPushover(env, "Trade Journal: Post-Session (test)", "Post-Session Review not filled out yet.");

    return new Response(
      JSON.stringify(
        { dateStr, weekday, skipped: false, row, preEmpty, postEmpty, note: "manual test run, time window ignored but day-skip logic still applied" },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    );
  },
};
