// Daily backup trigger — Cloudflare Worker
//
// Fully independent of Supabase Edge Functions and pg_cron. Two jobs:
//   1. Dispatch github-backup's "backup" action once a day at 2:00am
//      America/New_York.
//   2. ~30 minutes later, verify a new release actually appeared (proof the
//      workflow really completed, not just that it was accepted) — and send
//      a high-priority Pushover alert if either the dispatch itself failed,
//      or nothing showed up within the window.
//
// DEPLOY (browser-only, via the Cloudflare dashboard):
//   1. dash.cloudflare.com -> Workers & Pages -> Create -> Create Worker
//   2. Name it (e.g. "daily-backup-trigger"), then "Edit code" and paste
//      this entire file in, replacing the starter template. Save & Deploy.
//   3. Settings -> Variables -> add these as *encrypted* secrets:
//        SUPABASE_URL         e.g. https://YOUR_PROJECT_REF.supabase.co
//        SUPABASE_ANON_KEY    the project's anon key (safe to reuse — it's
//                             the same key the frontend already ships with)
//        PUSHOVER_USER_KEY
//        PUSHOVER_API_TOKEN
//   4. Settings -> Bindings -> KV Namespace -> create a namespace (e.g.
//      "BACKUP_STATE") and bind it to variable name BACKUP_KV.
//   5. Settings -> Trigger Events -> Cron Triggers -> Add: */5 * * * *
//      (every 5 minutes; the code below only acts at 2:00-2:04am ET for
//      dispatch, and 2:30-2:34am ET for verification)
//
// Note: this Worker only holds the anon key, not the service role key —
// github-backup's Edge Function leaves verify_jwt on default and doesn't
// check auth.uid()/role, so the anon key is sufficient for both the
// "backup" and "list" actions used here. No GitHub PAT is duplicated here —
// verification reuses github-backup's existing "list" action (same one
// BackupPanel.jsx already calls) rather than talking to GitHub directly.

const TARGET_HOUR = 2; // 2am America/New_York
const TARGET_MINUTE_WINDOW = [0, 4]; // dispatch fires once between 2:00–2:04am ET
const VERIFY_MINUTE_WINDOW = [30, 34]; // success check fires once between 2:30–2:34am ET

function nowInET() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    dateStr: `${get("year")}-${get("month")}-${get("day")}`,
    hour: parseInt(get("hour"), 10),
    minute: parseInt(get("minute"), 10),
  };
}

async function triggerBackup(env) {
  const res = await fetch(`${env.SUPABASE_URL}/functions/v1/github-backup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ action: "backup" }),
  });
  if (!res.ok) throw new Error(`github-backup call failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function listBackups(env) {
  const res = await fetch(`${env.SUPABASE_URL}/functions/v1/github-backup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ action: "list" }),
  });
  if (!res.ok) throw new Error(`github-backup list failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.backups || [];
}

async function sendPushover(env, title, message) {
  const body = new URLSearchParams({
    token: env.PUSHOVER_API_TOKEN,
    user: env.PUSHOVER_USER_KEY,
    title,
    message,
    priority: "1", // high priority — this is a failure alert
  });
  const res = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Pushover error: ${res.status} ${await res.text()}`);
}

async function alreadyTriggeredToday(env, dateStr) {
  return (await env.BACKUP_KV.get(`backup-${dateStr}`)) !== null;
}

async function markTriggered(env, dateStr) {
  await env.BACKUP_KV.put(`backup-${dateStr}`, "triggered", { expirationTtl: 72000 }); // 20h self-clean
}

async function getPendingDispatchTime(env, dateStr) {
  return env.BACKUP_KV.get(`pending-${dateStr}`);
}

async function markPending(env, dateStr, isoTimestamp) {
  await env.BACKUP_KV.put(`pending-${dateStr}`, isoTimestamp, { expirationTtl: 72000 });
}

async function alreadyVerifiedToday(env, dateStr) {
  return (await env.BACKUP_KV.get(`verified-${dateStr}`)) !== null;
}

async function markVerified(env, dateStr) {
  await env.BACKUP_KV.put(`verified-${dateStr}`, "checked", { expirationTtl: 72000 });
}

function inWindow(hour, minute, targetHour, [lo, hi]) {
  return hour === targetHour && minute >= lo && minute <= hi;
}

async function handleScheduled(env) {
  const { dateStr, hour, minute } = nowInET();

  // Step 1: dispatch, once, at 2:00-2:04am ET
  if (inWindow(hour, minute, TARGET_HOUR, TARGET_MINUTE_WINDOW) && !(await alreadyTriggeredToday(env, dateStr))) {
    await markTriggered(env, dateStr); // mark first so a crash mid-dispatch can't cause repeat attempts
    try {
      await triggerBackup(env);
      await markPending(env, dateStr, new Date().toISOString());
    } catch (err) {
      await sendPushover(
        env,
        "Backup FAILED to start",
        `The nightly backup could not even be dispatched: ${err.message}`
      );
    }
    return;
  }

  // Step 2: verify, once, ~15 minutes later, that a new release actually appeared
  if (inWindow(hour, minute, TARGET_HOUR, VERIFY_MINUTE_WINDOW) && !(await alreadyVerifiedToday(env, dateStr))) {
    const dispatchedAt = await getPendingDispatchTime(env, dateStr);
    if (!dispatchedAt) return; // nothing was dispatched today (e.g. dispatch itself failed) — already alerted above

    await markVerified(env, dateStr);
    try {
      const backups = await listBackups(env);
      const dispatchTime = new Date(dispatchedAt).getTime();
      const succeeded = backups.some((b) => b.published_at && new Date(b.published_at).getTime() > dispatchTime);
      if (!succeeded) {
        await sendPushover(
          env,
          "Backup did not complete",
          "The nightly backup was dispatched but no new release appeared within 30 minutes — check the Actions tab."
        );
      }
    } catch (err) {
      await sendPushover(env, "Backup verification failed", `Could not check whether last night's backup succeeded: ${err.message}`);
    }
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },

  // Manual test hook: visiting the Worker's URL triggers a backup
  // immediately, ignoring the time window and the once-per-day dedup —
  // useful to confirm the whole chain works before trusting the schedule.
  //
  // Browsers automatically fire a second request to /favicon.ico when you
  // visit a URL directly — without this guard, that alone causes a double
  // trigger. Only the root path actually triggers a backup; anything else
  // (favicon, etc.) is ignored with no Supabase call at all.
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname !== "/") {
      return new Response("ignored (not root path)", { status: 204 });
    }
    try {
      const result = await triggerBackup(env);
      return new Response(JSON.stringify({ triggered: true, result }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ triggered: false, error: String(err) }, null, 2), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};
