import { supabase } from './supabaseClient'

// ---------- MASTER LISTS ----------

const masterTables = {
  rules: 'rules_master',
  emotions: 'emotions_master',
  marketConditions: 'market_conditions_master',
  volatility: 'volatility_master',
}

export async function getMasterList(listKey) {
  const table = masterTables[listKey]
  const { data, error } = await supabase.from(table).select('*').order('name')
  if (error) throw error
  return data
}

export async function addMasterItem(listKey, name, userId) {
  const table = masterTables[listKey]
  const { data, error } = await supabase
    .from(table)
    .insert({ name, user_id: userId })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteMasterItem(listKey, id) {
  const table = masterTables[listKey]
  const { error } = await supabase.from(table).delete().eq('id', id)
  if (error) throw error
}

// ---------- TRADING DAYS ----------

export async function getTradingDay(userId, entryDate) {
  const { data, error } = await supabase
    .from('trading_days')
    .select(
      `*, day_violations(rule_id), day_emotions(emotion_id), screenshots(id, storage_path)`
    )
    .eq('user_id', userId)
    .eq('entry_date', entryDate)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function getMonthTradingDays(userId, year, month) {
  // month: 1-12
  const start = `${year}-${String(month).padStart(2, '0')}-01`
  const endMonth = month === 12 ? 1 : month + 1
  const endYear = month === 12 ? year + 1 : year
  const end = `${endYear}-${String(endMonth).padStart(2, '0')}-01`
  const { data, error } = await supabase
    .from('trading_days')
    .select('id, entry_date, followed_rules, on_vacation')
    .eq('user_id', userId)
    .gte('entry_date', start)
    .lt('entry_date', end)
  if (error) throw error
  return data
}

// Cheap staleness check for the Analytics local cache: returns just the most
// recent updated_at across all of this user's trading_days rows (single row,
// indexed, no joins). Analytics.jsx compares this against the timestamp it
// cached alongside the last full analytics fetch — if they match, nothing has
// changed since and the full wide fetch can be skipped. Returns null if the
// user has no trading_days rows yet (not an error, just "nothing logged").
//
// Relies on trading_days.updated_at being bumped on every change that affects
// analytics — including violation/emotion edits, which only touch the
// separate day_violations/day_emotions tables. See touchTradingDay() below,
// which DayDetail.jsx calls after those writes specifically to keep this
// check accurate.
export async function getLatestTradingDayUpdate(userId) {
  const { data, error } = await supabase
    .from('trading_days')
    .select('updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data?.updated_at ?? null
}

export async function upsertTradingDay(userId, entryDate, fields) {
  const { data, error } = await supabase
    .from('trading_days')
    .upsert(
      { user_id: userId, entry_date: entryDate, ...fields, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,entry_date' }
    )
    .select()
    .single()
  if (error) throw error
  return data
}

// Bumps a trading_days row's updated_at without changing any other field.
// Needed because writes to day_violations/day_emotions (via setDayViolations/
// setDayEmotions below) go to those separate join tables and don't touch
// trading_days.updated_at on their own — without this, a violation- or
// emotion-only edit could be invisible to the Analytics staleness check
// (getLatestTradingDayUpdate above) until some other field on the day changes.
export async function touchTradingDay(tradingDayId) {
  const { error } = await supabase
    .from('trading_days')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', tradingDayId)
  if (error) throw error
}

export async function setDayViolations(tradingDayId, ruleIds) {
  await supabase.from('day_violations').delete().eq('trading_day_id', tradingDayId)
  if (ruleIds.length === 0) return
  const rows = ruleIds.map((rule_id) => ({ trading_day_id: tradingDayId, rule_id }))
  const { error } = await supabase.from('day_violations').insert(rows)
  if (error) throw error
}

export async function setDayEmotions(tradingDayId, emotionIds) {
  await supabase.from('day_emotions').delete().eq('trading_day_id', tradingDayId)
  if (emotionIds.length === 0) return
  const rows = emotionIds.map((emotion_id) => ({ trading_day_id: tradingDayId, emotion_id }))
  const { error } = await supabase.from('day_emotions').insert(rows)
  if (error) throw error
}

// ---------- SCREENSHOTS ----------

export async function uploadScreenshot(userId, tradingDayId, file) {
  const path = `${userId}/${tradingDayId}/${Date.now()}_${file.name}`
  const { error: uploadError } = await supabase.storage.from('screenshots').upload(path, file)
  if (uploadError) throw uploadError
  const { data, error } = await supabase
    .from('screenshots')
    .insert({ trading_day_id: tradingDayId, storage_path: path })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getScreenshotUrl(storagePath) {
  const { data, error } = await supabase.storage
    .from('screenshots')
    .createSignedUrl(storagePath, 60 * 60 * 24 * 7) // 1 week
  if (error) throw error
  return data.signedUrl
}

export async function deleteScreenshot(id, storagePath) {
  await supabase.storage.from('screenshots').remove([storagePath])
  const { error } = await supabase.from('screenshots').delete().eq('id', id)
  if (error) throw error
}

// Pulls screenshots (just storage paths, grouped by entry_date) from trading_days
// entries in [startDate, endDateExclusive) — used to link a position opened a
// few days ago to today's exit, so the AI summary isn't limited to same-day
// round-trips. Signed URLs are generated client-side per screenshot, same as
// the current day's own screenshots.
export async function getRecentScreenshots(userId, startDate, endDateExclusive) {
  const { data, error } = await supabase
    .from('trading_days')
    .select('entry_date, screenshots(storage_path)')
    .eq('user_id', userId)
    .gte('entry_date', startDate)
    .lt('entry_date', endDateExclusive)
    .order('entry_date', { ascending: true })
  if (error) throw error
  return data
}

// ---------- ANALYTICS ----------

// Single wide fetch: pulls every trading_days row plus its joined violations,
// emotions, market condition, and volatility in one round trip. Everything else
// in src/lib/analytics.js is computed client-side from this one array.
// ai_summary is included so weekly/monthly rollup summaries can synthesize across
// each day's already-generated write-up, not just the raw numbers.
export async function getAnalyticsRawData(userId) {
  const { data, error } = await supabase
    .from('trading_days')
    .select(
      `id, entry_date, followed_rules, ai_summary, on_vacation,
       pre_max_loss, pre_setups, pre_mental_state, pre_notes,
       plan_followed, plan_deviation_notes,
       market_conditions_master(name),
       volatility_master(name),
       day_violations(rule_id, rules_master(name)),
       day_emotions(emotion_id, emotions_master(name))`
    )
    .eq('user_id', userId)
    .order('entry_date', { ascending: true })
  if (error) throw error
  return data
}

// Kept for any lightweight callers that only want lifetime totals rather than
// the full analytics module's rolling/trend/correlation views.
export async function getViolationFrequency(userId) {
  const { data, error } = await supabase
    .from('day_violations')
    .select('rule_id, rules_master(name), trading_days!inner(user_id)')
    .eq('trading_days.user_id', userId)
  if (error) throw error
  const counts = {}
  for (const row of data) {
    const name = row.rules_master?.name ?? 'Unknown'
    counts[name] = (counts[name] || 0) + 1
  }
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

export async function getEmotionFrequency(userId) {
  const { data, error } = await supabase
    .from('day_emotions')
    .select('emotion_id, emotions_master(name), trading_days!inner(user_id)')
    .eq('trading_days.user_id', userId)
  if (error) throw error
  const counts = {}
  for (const row of data) {
    const name = row.emotions_master?.name ?? 'Unknown'
    counts[name] = (counts[name] || 0) + 1
  }
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

// ---------- MARKET CALENDAR ----------
// Reference data synced weekly from Alpaca via the market-calendar-sync Edge
// Function + GitHub Actions. Lets analytics.js exclude weekends/holidays from
// Journaling Consistency and find the next real trading day for the "Day
// After" effect. This is a small, non-user-scoped table, so a plain select
// works for any signed-in user.
export async function getMarketCalendarDays(startDate, endDate) {
  const { data, error } = await supabase
    .from('market_calendar_days')
    .select('date, is_open')
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true })
  if (error) throw error
  return data
}

// ---------- AI SUMMARY (per-day) ----------

export async function generateAiSummary(payload) {
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData?.session?.access_token
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
  const res = await fetch(`${supabaseUrl}/functions/v1/ai-summary`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`AI summary failed: ${text}`)
  }
  const data = await res.json()
  return data.summary
}

// ---------- ROLLUP SUMMARIES (weekly / monthly) ----------
// One row per (user, period_type, period_start) in rollup_summaries. period_start is
// a 'yyyy-MM-dd' string: the Sunday of the week (matches Calendar's week start), or
// the 1st of the month.

export async function getRollupSummary(userId, periodType, periodStart) {
  const { data, error } = await supabase
    .from('rollup_summaries')
    .select('*')
    .eq('user_id', userId)
    .eq('period_type', periodType)
    .eq('period_start', periodStart)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function saveRollupSummary(userId, periodType, periodStart, summary) {
  const { data, error } = await supabase
    .from('rollup_summaries')
    .upsert(
      {
        user_id: userId,
        period_type: periodType,
        period_start: periodStart,
        summary,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,period_type,period_start' }
    )
    .select()
    .single()
  if (error) throw error
  return data
}

export async function generateRollupSummary(payload) {
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData?.session?.access_token
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
  const res = await fetch(`${supabaseUrl}/functions/v1/rollup-summary`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Rollup summary failed: ${text}`)
  }
  const data = await res.json()
  return data.summary
}

// ---------- BACKUP / RESTORE ----------
// All calls go through the `github-backup` Edge Function, which holds the
// GitHub PAT server-side and triggers/lists workflow runs + releases on your behalf.

async function callBackupFunction(action, payload = {}) {
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData?.session?.access_token
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
  const res = await fetch(`${supabaseUrl}/functions/v1/github-backup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ action, ...payload }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Backup function failed: ${text}`)
  }
  return res.json()
}

// Returns [{ id, tag_name, name, published_at, size_bytes }]
export async function listBackups() {
  const data = await callBackupFunction('list')
  return data.backups || []
}

export async function triggerBackupNow() {
  return callBackupFunction('backup')
}

export async function triggerRestore(releaseTag) {
  return callBackupFunction('restore', { release_tag: releaseTag })
}
