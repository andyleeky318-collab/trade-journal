// Pure functions that compute derived behavioral/psychological stats from the
// raw trading_days rows returned by getAnalyticsRawData(). No network calls here —
// everything is plain JS so it's easy to test and cheap to re-run on every render.

import { parseISO, subDays, differenceInCalendarDays, format } from 'date-fns'

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function inLastNDays(rows, days, from = new Date()) {
  const cutoff = subDays(from, days)
  return rows.filter((r) => parseISO(r.entry_date) >= cutoff)
}

function ruleNames(row) {
  return (row.day_violations || []).map((v) => v.rules_master?.name).filter(Boolean)
}

function emotionNames(row) {
  return (row.day_emotions || []).map((e) => e.emotions_master?.name).filter(Boolean)
}

// Given a 'yyyy-MM-dd' date and a sorted list of 'yyyy-MM-dd' open-market
// dates, returns the next date strictly after it that the market was open —
// skipping weekends and holidays in one step. Returns null past the end of
// the synced calendar range.
function getNextTradingDay(dateStr, openDatesSorted) {
  const idx = openDatesSorted.findIndex((d) => d > dateStr)
  return idx === -1 ? null : openDatesSorted[idx]
}

// ---------- Adherence ----------

export function getAdherenceRate(rows) {
  const answered = rows.filter((r) => r.followed_rules !== null)
  if (!answered.length) return null
  const followed = answered.filter((r) => r.followed_rules === true).length
  return followed / answered.length
}

export function getRollingAdherence(rows) {
  return {
    d7: getAdherenceRate(inLastNDays(rows, 7)),
    d30: getAdherenceRate(inLastNDays(rows, 30)),
    d90: getAdherenceRate(inLastNDays(rows, 90)),
  }
}

// ---------- Streaks ----------

export function getStreaks(rows) {
  const sorted = [...rows]
    .filter((r) => r.followed_rules !== null)
    .sort((a, b) => a.entry_date.localeCompare(b.entry_date))

  let longest = 0
  let run = 0
  for (const r of sorted) {
    if (r.followed_rules === true) {
      run += 1
      longest = Math.max(longest, run)
    } else {
      run = 0
    }
  }

  let current = 0
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].followed_rules === true) current += 1
    else break
  }

  return { current, longest }
}

// ---------- Day-of-week breakdown ----------

export function getDayOfWeekBreakdown(rows) {
  const buckets = Array.from({ length: 7 }, () => ({ total: 0, followed: 0 }))
  for (const r of rows) {
    if (r.followed_rules === null) continue
    const dow = parseISO(r.entry_date).getDay()
    buckets[dow].total += 1
    if (r.followed_rules) buckets[dow].followed += 1
  }
  return buckets.map((b, i) => ({
    day: DOW_LABELS[i],
    total: b.total,
    violationRate: b.total ? 1 - b.followed / b.total : null,
  }))
}

// ---------- Rule frequency & trend ----------

export function getRuleFrequency(rows) {
  const counts = {}
  for (const r of rows) {
    for (const name of ruleNames(r)) counts[name] = (counts[name] || 0) + 1
  }
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

export function getRuleTrend30Day(rows, from = new Date()) {
  const last30 = inLastNDays(rows, 30, from)
  const prev30 = rows.filter((r) => {
    const d = parseISO(r.entry_date)
    return d >= subDays(from, 60) && d < subDays(from, 30)
  })
  const countBy = (list) => {
    const c = {}
    for (const r of list) for (const name of ruleNames(r)) c[name] = (c[name] || 0) + 1
    return c
  }
  const curr = countBy(last30)
  const prev = countBy(prev30)
  const names = new Set([...Object.keys(curr), ...Object.keys(prev)])
  return [...names]
    .map((name) => ({
      name,
      current: curr[name] || 0,
      previous: prev[name] || 0,
      delta: (curr[name] || 0) - (prev[name] || 0),
    }))
    .sort((a, b) => b.current - a.current)
}

export function getRuleCoViolation(rows, limit = 10) {
  const pairCounts = {}
  for (const r of rows) {
    const names = ruleNames(r)
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const key = [names[i], names[j]].sort().join(' + ')
        pairCounts[key] = (pairCounts[key] || 0) + 1
      }
    }
  }
  return Object.entries(pairCounts)
    .map(([pair, count]) => ({ pair, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

// ---------- Emotions ----------

export function getEmotionFrequency(rows) {
  const counts = {}
  for (const r of rows) {
    for (const name of emotionNames(r)) counts[name] = (counts[name] || 0) + 1
  }
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

export function getEmotionFrequencyTrend(rows, from = new Date()) {
  const last30 = getEmotionFrequency(inLastNDays(rows, 30, from))
  const prev30 = getEmotionFrequency(
    rows.filter((r) => {
      const d = parseISO(r.entry_date)
      return d >= subDays(from, 60) && d < subDays(from, 30)
    })
  )
  const prevMap = Object.fromEntries(prev30.map((e) => [e.name, e.count]))
  return last30.map((e) => ({ ...e, delta: e.count - (prevMap[e.name] || 0) }))
}

export function getEmotionViolationCorrelation(rows, minOccurrences = 2) {
  const answered = rows.filter((r) => r.followed_rules !== null)
  const baseline = getAdherenceRate(answered)
  const baselineViolationRate = baseline === null ? null : 1 - baseline

  const stats = {}
  for (const r of answered) {
    for (const name of emotionNames(r)) {
      if (!stats[name]) stats[name] = { total: 0, violations: 0 }
      stats[name].total += 1
      if (r.followed_rules === false) stats[name].violations += 1
    }
  }

  return Object.entries(stats)
    .filter(([, s]) => s.total >= minOccurrences)
    .map(([name, s]) => ({
      name,
      occurrences: s.total,
      violationRate: s.violations / s.total,
      baselineViolationRate,
      delta: baselineViolationRate === null ? null : s.violations / s.total - baselineViolationRate,
    }))
    .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))
}

// emotion x rule co-occurrence, counted on violation days only
export function getEmotionRuleHeatmap(rows) {
  const matrix = {}
  const ruleSet = new Set()
  const emotionSet = new Set()

  for (const r of rows) {
    if (r.followed_rules !== false) continue
    const emotionsToday = emotionNames(r)
    const rulesToday = ruleNames(r)
    for (const em of emotionsToday) {
      emotionSet.add(em)
      if (!matrix[em]) matrix[em] = {}
      for (const rule of rulesToday) {
        ruleSet.add(rule)
        matrix[em][rule] = (matrix[em][rule] || 0) + 1
      }
    }
  }

  return { emotions: [...emotionSet], rules: [...ruleSet], matrix }
}

// ---------- Market condition / volatility ----------

export function getConditionViolationRates(rows, field = 'market_conditions_master') {
  const stats = {}
  for (const r of rows) {
    if (r.followed_rules === null) continue
    const name = r[field]?.name
    if (!name) continue
    if (!stats[name]) stats[name] = { total: 0, violations: 0 }
    stats[name].total += 1
    if (r.followed_rules === false) stats[name].violations += 1
  }
  return Object.entries(stats)
    .map(([name, s]) => ({ name, total: s.total, violationRate: s.violations / s.total }))
    .sort((a, b) => b.violationRate - a.violationRate)
}

// ---------- Journaling consistency & "day after" effect ----------

// calendarDays: optional array of { date: 'yyyy-MM-dd', is_open: boolean } from
// getMarketCalendarDays(). When present, the denominator is actual trading
// days in the window instead of flat calendar days, so weekends/holidays don't
// silently drag the percentage down. Falls back to the old flat-30 behavior
// if the calendar hasn't been synced yet.
// Days marked on_vacation are excluded entirely — same treatment as a market
// holiday — so time off doesn't count against either side of the ratio.
export function getJournalingConsistency(rows, calendarDays = [], days = 30, from = new Date()) {
  const cutoff = subDays(from, days)
  const nonVacationRows = rows.filter((r) => !r.on_vacation)
  const loggedDays = inLastNDays(nonVacationRows, days, from).length

  const vacationDatesInWindow = new Set(
    rows
      .filter((r) => r.on_vacation && parseISO(r.entry_date) >= cutoff && parseISO(r.entry_date) <= from)
      .map((r) => r.entry_date)
  )

  if (!calendarDays || calendarDays.length === 0) {
    return {
      loggedDays,
      windowDays: Math.max(0, days - vacationDatesInWindow.size),
      tradingDaysOnly: false,
    }
  }

  const tradingDaysInWindow = calendarDays.filter(
    (d) =>
      d.is_open &&
      parseISO(d.date) >= cutoff &&
      parseISO(d.date) <= from &&
      !vacationDatesInWindow.has(d.date)
  ).length

  return { loggedDays, windowDays: tradingDaysInWindow, tradingDaysOnly: true }
}

// calendarDays: same shape as above. When present, "the day after" means the
// next actual trading day (so a Friday violation is correctly compared
// against the following Monday) instead of requiring a literal one-calendar-day
// gap, which silently dropped every Friday->Monday pair before.
export function getDayAfterEffect(rows, calendarDays = []) {
  const sorted = [...rows]
    .filter((r) => r.followed_rules !== null)
    .sort((a, b) => a.entry_date.localeCompare(b.entry_date))

  const rowByDate = new Map(sorted.map((r) => [r.entry_date, r]))
  const useTradingCalendar = calendarDays && calendarDays.length > 0
  const openDatesSorted = useTradingCalendar
    ? calendarDays.filter((d) => d.is_open).map((d) => d.date).sort()
    : null

  let afterViolationTotal = 0
  let afterViolationViolated = 0
  let afterCleanTotal = 0
  let afterCleanViolated = 0

  for (let i = 0; i < sorted.length; i++) {
    const prev = sorted[i]
    let nextDate = null

    if (useTradingCalendar) {
      nextDate = getNextTradingDay(prev.entry_date, openDatesSorted)
    } else {
      // Fallback to the old behavior: only a literal next calendar day counts.
      const candidate = sorted[i + 1]
      if (
        candidate &&
        differenceInCalendarDays(parseISO(candidate.entry_date), parseISO(prev.entry_date)) === 1
      ) {
        nextDate = candidate.entry_date
      }
    }

    if (!nextDate) continue
    const curr = rowByDate.get(nextDate)
    if (!curr || curr.followed_rules === null) continue

    if (prev.followed_rules === false) {
      afterViolationTotal += 1
      if (curr.followed_rules === false) afterViolationViolated += 1
    } else {
      afterCleanTotal += 1
      if (curr.followed_rules === false) afterCleanViolated += 1
    }
  }

  return {
    afterViolationRate: afterViolationTotal ? afterViolationViolated / afterViolationTotal : null,
    afterCleanRate: afterCleanTotal ? afterCleanViolated / afterCleanTotal : null,
    afterViolationSample: afterViolationTotal,
    afterCleanSample: afterCleanTotal,
    tradingDaysOnly: useTradingCalendar,
  }
}

// ---------- Pre-Session Plan adherence ----------

export function getPlanAdherence(rows) {
  const rated = rows.filter((r) => r.plan_followed === true || r.plan_followed === false)
  const rate = (list) => {
    if (!list.length) return null
    return list.filter((r) => r.plan_followed === true).length / list.length
  }
  return {
    d7: rate(inLastNDays(rated, 7)),
    d30: rate(inLastNDays(rated, 30)),
    d90: rate(inLastNDays(rated, 90)),
  }
}

// ---------- Weekly rollup ----------

export function getWeeklyRollup(rows, from = new Date()) {
  const last7 = inLastNDays(rows, 7, from)
  const prev7 = rows.filter((r) => {
    const d = parseISO(r.entry_date)
    return d >= subDays(from, 14) && d < subDays(from, 7)
  })
  return {
    adherence: getAdherenceRate(last7),
    prevAdherence: getAdherenceRate(prev7),
    topEmotion: getEmotionFrequency(last7)[0]?.name ?? null,
    topViolation: getRuleFrequency(last7)[0]?.name ?? null,
    daysLogged: last7.length,
  }
}

// ---------- Arbitrary-period stats (for AI rollup summaries) ----------

// Scopes the same building blocks used elsewhere to an arbitrary [startDate, endDateExclusive)
// range, and also pulls along each day's already-generated ai_summary text (if any) so the
// rollup-summary Edge Function can synthesize across the individual daily write-ups, not just
// the numbers. startDate/endDateExclusive are JS Date objects.
export function getPeriodStats(rows, startDate, endDateExclusive) {
  const period = rows.filter((r) => {
    const d = parseISO(r.entry_date)
    return d >= startDate && d < endDateExclusive
  })

  const rated = period.filter((r) => r.plan_followed === true || r.plan_followed === false)

  return {
    daysLogged: period.length,
    adherence: getAdherenceRate(period),
    planAdherence: rated.length ? rated.filter((r) => r.plan_followed === true).length / rated.length : null,
    topViolations: getRuleFrequency(period).slice(0, 5),
    topEmotions: getEmotionFrequency(period).slice(0, 5),
    dailySummaries: period
      .filter((r) => r.ai_summary)
      .sort((a, b) => a.entry_date.localeCompare(b.entry_date))
      .map((r) => ({ date: r.entry_date, summary: r.ai_summary })),
  }
}

// ---------- Vacation-return context ----------

// Walks backward through logged rows immediately preceding entryDate and
// counts how many consecutive trailing entries are marked on_vacation. Used
// to flag a rough day right after time off as a possible re-entry/rust day
// rather than folding it into ordinary streak/pattern math. Best-effort: only
// knows about vacation days that were actually logged, so an unlogged gap
// (no entries at all) won't be detected here.
export function getVacationReturnContext(rows, entryDate) {
  const priorSorted = [...rows]
    .filter((r) => r.entry_date < entryDate)
    .sort((a, b) => a.entry_date.localeCompare(b.entry_date))

  let count = 0
  let lastVacationDate = null
  for (let i = priorSorted.length - 1; i >= 0; i--) {
    if (priorSorted[i].on_vacation) {
      count += 1
      lastVacationDate = lastVacationDate || priorSorted[i].entry_date
    } else {
      break
    }
  }

  return {
    returningFromVacation: count > 0,
    vacationDaysBeforeEntry: count,
    lastVacationDate,
  }
}

// ---------- Screenshot lookback window (trading-day aware) ----------

// Returns the 'yyyy-MM-dd' date to use as the START of a screenshot fetch range,
// such that the range [start, entryDate) contains the last `days` actual trading
// days before entryDate — skipping weekends and holidays via calendarDays, the
// same way getDayAfterEffect does. This matters specifically for cross-day trade
// linking: a flat "N calendar days back" window can silently exclude a position
// opened right before a holiday+weekend stretch, even though only a couple of
// real trading days actually passed. Falls back to a wider flat buffer if the
// market calendar hasn't been synced yet, since we can't safely assume weekdays
// are trading days without it.
export function getScreenshotLookbackStartDate(calendarDays, entryDate, days = 3) {
  if (!calendarDays || calendarDays.length === 0) {
    // No calendar data — use a generous flat buffer (2x + a few days) so a
    // holiday/weekend cluster is less likely to silently eat the window.
    return format(subDays(parseISO(entryDate), days * 2 + 3), 'yyyy-MM-dd')
  }

  const openDatesBefore = calendarDays
    .filter((d) => d.is_open && d.date < entryDate)
    .map((d) => d.date)
    .sort()

  if (openDatesBefore.length === 0) {
    return format(subDays(parseISO(entryDate), days * 2 + 3), 'yyyy-MM-dd')
  }

  const lastNTradingDays = openDatesBefore.slice(-days)
  return lastNTradingDays[0]
}

// ---------- AI summary context (per-day pattern lookup) ----------

// Given the full analytics rows, the market calendar, a specific entry_date,
// the violation/emotion names selected for THAT day, and (optionally) today's
// market condition / volatility type, returns a compact object describing how
// today's entry fits historical patterns. Everything here is computed from
// rows strictly BEFORE entryDate, so it reads as prior context feeding into
// today rather than today influencing itself.
export function getAiSummaryContext(
  rows,
  calendarDays,
  entryDate,
  todayViolations = [],
  todayEmotions = [],
  todayMarketCondition = null,
  todayVolatility = null
) {
  const priorRows = rows.filter((r) => r.entry_date < entryDate)

  // How often each of today's violated rules has come up before, and its rank.
  const ruleFreq = getRuleFrequency(priorRows)
  const ruleRankMap = new Map(ruleFreq.map((r, i) => [r.name, { count: r.count, rank: i + 1 }]))
  const violationPatterns = todayViolations.map((name) => {
    const info = ruleRankMap.get(name)
    return info
      ? { name, priorCount: info.count, rank: info.rank, isTopPattern: info.rank <= 3 }
      : { name, priorCount: 0, rank: null, isTopPattern: false }
  })

  // Historical violation-rate lift for each of today's emotions vs baseline.
  const emotionCorr = getEmotionViolationCorrelation(priorRows, 2)
  const emotionCorrMap = new Map(emotionCorr.map((e) => [e.name, e]))
  const emotionPatterns = todayEmotions.map((name) => {
    const info = emotionCorrMap.get(name)
    return info
      ? {
          name,
          violationRate: info.violationRate,
          baselineViolationRate: info.baselineViolationRate,
          delta: info.delta,
        }
      : { name, violationRate: null, baselineViolationRate: null, delta: null }
  })

  // Historical violation rate for today's market condition / volatility type, if set.
  const marketConditionRates = getConditionViolationRates(priorRows, 'market_conditions_master')
  const volatilityRates = getConditionViolationRates(priorRows, 'volatility_master')
  const marketConditionPattern = todayMarketCondition
    ? marketConditionRates.find((c) => c.name === todayMarketCondition) || null
    : null
  const volatilityPattern = todayVolatility
    ? volatilityRates.find((c) => c.name === todayVolatility) || null
    : null

  // The single most recent prior logged day, for a concrete "yesterday was X" note.
  const loggedPrior = [...priorRows]
    .filter((r) => r.followed_rules !== null)
    .sort((a, b) => a.entry_date.localeCompare(b.entry_date))
  const lastLogged = loggedPrior[loggedPrior.length - 1]
  const previousDay = lastLogged
    ? { date: lastLogged.entry_date, followedRules: lastLogged.followed_rules }
    : null

  // General historical "day after a violation" rates, for the trajectory framing.
  const dayAfterEffect = getDayAfterEffect(priorRows, calendarDays)

  const streaks = getStreaks(priorRows)
  const rollingAdherence = getRollingAdherence(priorRows)

  const dow = parseISO(entryDate).getDay()
  const dowBucket = getDayOfWeekBreakdown(priorRows)[dow]

  const weeklyRollup = getWeeklyRollup(priorRows, parseISO(entryDate))

  // Whether this entry follows a marked vacation break, so a rough day can be
  // read as possible rust/re-entry rather than a resumed discipline pattern.
  const vacationContext = getVacationReturnContext(rows, entryDate)

  return {
    violationPatterns,
    emotionPatterns,
    marketConditionPattern,
    volatilityPattern,
    previousDay,
    dayAfterEffect,
    streaks,
    rollingAdherence,
    dayOfWeek: { day: DOW_LABELS[dow], violationRate: dowBucket.violationRate, sample: dowBucket.total },
    weeklyRollup,
    vacationContext,
  }
}

// ---------- Recent qualitative history (for deep cross-day AI analysis) ----------

// Returns the full text + structured data for every logged day in the `days`
// window strictly before entryDate, oldest first. Unlike getAiSummaryContext
// (which reduces history to stats), this hands the model your actual raw
// journal text across multiple days — including each day's own prior AI
// summary, so it can check whether ITS OWN past advice was followed, not
// just whether you followed your own self-written notes.
export function getRecentQualitativeHistory(rows, entryDate, days = 14) {
  const cutoff = subDays(parseISO(entryDate), days)
  return rows
    .filter((r) => r.entry_date < entryDate && parseISO(r.entry_date) >= cutoff)
    .sort((a, b) => a.entry_date.localeCompare(b.entry_date))
    .map((r) => ({
      entry_date: r.entry_date,
      on_vacation: r.on_vacation || false,
      followed_rules: r.followed_rules,
      violations: ruleNames(r),
      emotions: emotionNames(r),
      market_condition: r.market_conditions_master?.name ?? null,
      volatility: r.volatility_master?.name ?? null,
      pre_mental_state: r.pre_mental_state || null,
      pre_setups: r.pre_setups || null,
      pre_notes: r.pre_notes || null,
      notes: r.notes || null,
      improvements: r.improvements || null,
      plan_followed: r.plan_followed,
      plan_deviation_notes: r.plan_deviation_notes || null,
      ai_summary: r.ai_summary || null,
    }))
}

// ---------- Convenience: compute everything at once ----------

// calendarDays: optional array from getMarketCalendarDays(). Pass it through
// whenever you have it — only journalingConsistency and dayAfterEffect use it.
export function computeAllAnalytics(rows, calendarDays = []) {
  return {
    rollingAdherence: getRollingAdherence(rows),
    streaks: getStreaks(rows),
    dayOfWeek: getDayOfWeekBreakdown(rows),
    ruleFrequency: getRuleFrequency(rows),
    ruleTrend: getRuleTrend30Day(rows),
    ruleCoViolation: getRuleCoViolation(rows),
    emotionFrequency: getEmotionFrequency(rows),
    emotionTrend: getEmotionFrequencyTrend(rows),
    emotionCorrelation: getEmotionViolationCorrelation(rows),
    heatmap: getEmotionRuleHeatmap(rows),
    marketConditionRates: getConditionViolationRates(rows, 'market_conditions_master'),
    volatilityRates: getConditionViolationRates(rows, 'volatility_master'),
    journalingConsistency: getJournalingConsistency(rows, calendarDays),
    dayAfterEffect: getDayAfterEffect(rows, calendarDays),
    planAdherence: getPlanAdherence(rows),
    weeklyRollup: getWeeklyRollup(rows),
  }
}
