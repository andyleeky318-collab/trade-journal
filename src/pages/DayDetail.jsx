import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import EditableChecklist from '../components/EditableChecklist'
import EditableDropdown from '../components/EditableDropdown'
import FormattedSummary from '../components/FormattedSummary'
import { readCache, writeCache } from '../lib/pageCache'
import {
  getMasterList,
  addMasterItem,
  deleteMasterItem,
  getTradingDay,
  upsertTradingDay,
  setDayViolations,
  setDayEmotions,
  touchTradingDay,
  uploadScreenshot,
  getScreenshotUrl,
  deleteScreenshot,
  generateAiSummary,
  getAnalyticsRawData,
  getMarketCalendarDays,
  getRecentScreenshots,
} from '../lib/api'
import {
  getAiSummaryContext,
  getRecentQualitativeHistory,
  getScreenshotLookbackStartDate,
} from '../lib/analytics'
import { format, parseISO, subDays } from 'date-fns'

const SCREENSHOT_LOOKBACK_DAYS = 3

// ---------- Local cache (stale-while-revalidate) ----------
// Two independent caches, since they change at very different rates:
//   - master lists (rules/emotions/market conditions/volatility) rarely
//     change and are the same across every day you visit — cached once per
//     user, not per date.
//   - the day's own entry changes whenever you edit it, and is cached per
//     (user, date).
// Both render instantly on mount if present; loadAll always still runs the
// full fetch in the background afterward and replaces state once it lands,
// same pattern as Calendar and Analytics. Screenshot thumbnails use cached
// signed URLs, which expire after 1 week — a day you haven't opened in over
// a week may show a brief broken-image flash before the background fetch
// replaces them with fresh URLs. Self-correcting, not a data problem.
//
// The day-entry cache is only refreshed by loadAll's background fetch, not
// on every individual edit — so if you leave a day and instantly return to
// it, you may briefly see the state from just before your last edit before
// the background fetch (which always runs on mount) catches it up. This
// mirrors the same honest tradeoff already accepted for Calendar.

function masterListsCacheKey(userId) {
  return `masterLists_${userId}`
}

function dayEntryCacheKey(userId, date) {
  return `dayEntry_${userId}_${date}`
}

export default function DayDetail() {
  const { date } = useParams() // yyyy-MM-dd
  const { user } = useAuth()
  const navigate = useNavigate()

  const [rules, setRules] = useState([])
  const [emotions, setEmotions] = useState([])
  const [marketConditions, setMarketConditions] = useState([])
  const [volatilities, setVolatilities] = useState([])

  const [tradingDayId, setTradingDayId] = useState(null)
  const [followedRules, setFollowedRules] = useState(null) // true/false/null
  const [selectedViolations, setSelectedViolations] = useState([])
  const [selectedEmotions, setSelectedEmotions] = useState([])
  const [marketConditionId, setMarketConditionId] = useState(null)
  const [volatilityId, setVolatilityId] = useState(null)
  const [notes, setNotes] = useState('')
  const [improvements, setImprovements] = useState('')
  const [aiSummary, setAiSummary] = useState('')
  const [screenshots, setScreenshots] = useState([]) // [{id, storage_path, url}]
  const [lightboxIndex, setLightboxIndex] = useState(null) // index into screenshots, or null

  // On Vacation — excludes this day from Journaling Consistency entirely
  // (same treatment as a market holiday) so time off doesn't count against it.
  const [onVacation, setOnVacation] = useState(false)

  // Pre-Session Plan
  const [preMaxLoss, setPreMaxLoss] = useState('')
  const [preSetups, setPreSetups] = useState('')
  const [preMentalState, setPreMentalState] = useState('')
  const [preNotes, setPreNotes] = useState('')

  // Post-Session Review — plan adherence
  const [planFollowed, setPlanFollowed] = useState(null) // true/false/null
  const [planDeviationNotes, setPlanDeviationNotes] = useState('')

  const [loading, setLoading] = useState(true) // blocks render — only true when master lists aren't cached at all
  const [refreshing, setRefreshing] = useState(false) // background revalidation in flight, non-blocking
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [generatingSummary, setGeneratingSummary] = useState(false)

  // Applies a trading_days row (or null, for an unlogged day) to all the
  // day-specific state fields. Shared between the cache-hit render and the
  // fresh-fetch render so both paths stay in sync with the same shape.
  const applyDayEntryToState = useCallback((dayEntry) => {
    if (dayEntry) {
      setTradingDayId(dayEntry.id)
      setFollowedRules(dayEntry.followed_rules)
      setMarketConditionId(dayEntry.market_condition_id)
      setVolatilityId(dayEntry.volatility_id)
      setNotes(dayEntry.notes || '')
      setImprovements(dayEntry.improvements || '')
      setAiSummary(dayEntry.ai_summary || '')
      setSelectedViolations((dayEntry.day_violations || []).map((v) => v.rule_id))
      setSelectedEmotions((dayEntry.day_emotions || []).map((e) => e.emotion_id))
      setOnVacation(dayEntry.on_vacation || false)
      setPreMaxLoss(dayEntry.pre_max_loss ?? '')
      setPreSetups(dayEntry.pre_setups || '')
      setPreMentalState(dayEntry.pre_mental_state || '')
      setPreNotes(dayEntry.pre_notes || '')
      setPlanFollowed(dayEntry.plan_followed)
      setPlanDeviationNotes(dayEntry.plan_deviation_notes || '')
    } else {
      setTradingDayId(null)
      setFollowedRules(null)
      setMarketConditionId(null)
      setVolatilityId(null)
      setNotes('')
      setImprovements('')
      setAiSummary('')
      setSelectedViolations([])
      setSelectedEmotions([])
      setOnVacation(false)
      setPreMaxLoss('')
      setPreSetups('')
      setPreMentalState('')
      setPreNotes('')
      setPlanFollowed(null)
      setPlanDeviationNotes('')
    }
  }, [])

  const loadAll = useCallback(
    async (cancelledRef) => {
      if (!user) return

      const masterKey = masterListsCacheKey(user.id)
      const dayKey = dayEntryCacheKey(user.id, date)
      const cachedMaster = readCache(masterKey)
      const cachedDay = readCache(dayKey)

      if (cachedMaster) {
        setRules(cachedMaster.rules)
        setEmotions(cachedMaster.emotions)
        setMarketConditions(cachedMaster.marketConditions)
        setVolatilities(cachedMaster.volatilities)
      }

      if (cachedDay) {
        applyDayEntryToState(cachedDay.entry)
        setScreenshots(cachedDay.screenshots || [])
      } else {
        // No cached entry for this specific date — the default empty state
        // IS the correct "not yet logged" appearance, so render it directly
        // rather than blocking on a spinner. If the day actually has data,
        // it'll populate a moment later once the background fetch resolves.
        applyDayEntryToState(null)
        setScreenshots([])
      }

      if (cachedMaster) {
        // We have enough to render a fully-formed page immediately.
        setLoading(false)
        setRefreshing(true)
      } else {
        setLoading(true)
      }

      try {
        const [rulesData, emotionsData, mcData, volData, dayEntry] = await Promise.all([
          getMasterList('rules'),
          getMasterList('emotions'),
          getMasterList('marketConditions'),
          getMasterList('volatility'),
          getTradingDay(user.id, date),
        ])

        if (cancelledRef.current) return

        setRules(rulesData)
        setEmotions(emotionsData)
        setMarketConditions(mcData)
        setVolatilities(volData)
        writeCache(masterKey, {
          rules: rulesData,
          emotions: emotionsData,
          marketConditions: mcData,
          volatilities: volData,
        })

        applyDayEntryToState(dayEntry)

        let withUrls = []
        if (dayEntry) {
          const shots = dayEntry.screenshots || []
          withUrls = await Promise.all(
            shots.map(async (s) => ({ ...s, url: await getScreenshotUrl(s.storage_path) }))
          )
        }
        if (cancelledRef.current) return
        setScreenshots(withUrls)
        writeCache(dayKey, { entry: dayEntry, screenshots: withUrls })
      } finally {
        if (!cancelledRef.current) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    },
    [user, date, applyDayEntryToState]
  )

  useEffect(() => {
    const cancelledRef = { current: false }
    loadAll(cancelledRef)
    return () => {
      cancelledRef.current = true
    }
  }, [loadAll])

  // Keyboard navigation while the lightbox is open: ← / → to page, Esc to close
  useEffect(() => {
    if (lightboxIndex === null) return
    const handleKeyDown = (e) => {
      if (e.key === 'ArrowLeft') {
        setLightboxIndex((i) => (i - 1 + screenshots.length) % screenshots.length)
      } else if (e.key === 'ArrowRight') {
        setLightboxIndex((i) => (i + 1) % screenshots.length)
      } else if (e.key === 'Escape') {
        setLightboxIndex(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [lightboxIndex, screenshots.length])

  // Ensures a trading_days row exists, returns its id
  const ensureDayRow = async (fields = {}) => {
    const row = await upsertTradingDay(user.id, date, fields)
    setTradingDayId(row.id)
    return row.id
  }

  const handleVacationToggle = async () => {
    const next = !onVacation
    setOnVacation(next)
    setSaving(true)
    try {
      await ensureDayRow({ on_vacation: next })
    } finally {
      setSaving(false)
    }
  }

  const handleFollowedRules = async (value) => {
    setFollowedRules(value)
    setSaving(true)
    try {
      const id = await ensureDayRow({ followed_rules: value })
      if (value === true) {
        setSelectedViolations([])
        await setDayViolations(id, [])
      }
    } finally {
      setSaving(false)
    }
  }

  const toggleViolation = async (ruleId) => {
    const next = selectedViolations.includes(ruleId)
      ? selectedViolations.filter((id) => id !== ruleId)
      : [...selectedViolations, ruleId]
    setSelectedViolations(next)
    setSaving(true)
    try {
      const id = tradingDayId || (await ensureDayRow({ followed_rules: false }))
      await setDayViolations(id, next)
      // day_violations is a separate table — this write alone wouldn't bump
      // trading_days.updated_at, which would make the change invisible to
      // Analytics' staleness check. Force the bump explicitly.
      await touchTradingDay(id)
    } finally {
      setSaving(false)
    }
  }

  const toggleEmotion = async (emotionId) => {
    const next = selectedEmotions.includes(emotionId)
      ? selectedEmotions.filter((id) => id !== emotionId)
      : [...selectedEmotions, emotionId]
    setSelectedEmotions(next)
    setSaving(true)
    try {
      const id = tradingDayId || (await ensureDayRow())
      await setDayEmotions(id, next)
      // Same reasoning as toggleViolation above — day_emotions is a separate
      // table and needs an explicit touch to keep the staleness check accurate.
      await touchTradingDay(id)
    } finally {
      setSaving(false)
    }
  }

  const handleMarketConditionChange = async (id) => {
    setMarketConditionId(id)
    setSaving(true)
    try {
      await ensureDayRow({ market_condition_id: id })
    } finally {
      setSaving(false)
    }
  }

  const handleVolatilityChange = async (id) => {
    setVolatilityId(id)
    setSaving(true)
    try {
      await ensureDayRow({ volatility_id: id })
    } finally {
      setSaving(false)
    }
  }

  const handleTextBlur = async (field, value) => {
    setSaving(true)
    try {
      await ensureDayRow({ [field]: value })
    } finally {
      setSaving(false)
    }
  }

  const handleMaxLossBlur = async (value) => {
    setSaving(true)
    try {
      await ensureDayRow({ pre_max_loss: value === '' ? null : Number(value) })
    } finally {
      setSaving(false)
    }
  }

  const handlePlanFollowed = async (value) => {
    setPlanFollowed(value)
    setSaving(true)
    try {
      await ensureDayRow({ plan_followed: value })
    } finally {
      setSaving(false)
    }
  }

  const handleAddMaster = async (listKey, setList, name) => {
    const item = await addMasterItem(listKey, name, user.id)
    setList((prev) => [...prev, item].sort((a, b) => a.name.localeCompare(b.name)))
  }

  const handleDeleteMaster = async (listKey, setList, id) => {
    await deleteMasterItem(listKey, id)
    setList((prev) => prev.filter((i) => i.id !== id))
  }

  // Handles one or many files selected at once. Uploads run in parallel,
  // then all new screenshots are appended to state together.
  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    setUploading(true)
    setSaving(true)
    try {
      const id = tradingDayId || (await ensureDayRow())
      const uploaded = await Promise.all(
        files.map(async (file) => {
          const record = await uploadScreenshot(user.id, id, file)
          const url = await getScreenshotUrl(record.storage_path)
          return { ...record, url }
        })
      )
      setScreenshots((prev) => [...prev, ...uploaded])
    } finally {
      setUploading(false)
      setSaving(false)
      e.target.value = ''
    }
  }

  const handleDeleteScreenshot = async (shot) => {
    await deleteScreenshot(shot.id, shot.storage_path)
    setScreenshots((prev) => prev.filter((s) => s.id !== shot.id))
    setLightboxIndex(null)
  }

  const handleGenerateSummary = async () => {
    setGeneratingSummary(true)
    try {
      const violationNames = rules
        .filter((r) => selectedViolations.includes(r.id))
        .map((r) => r.name)
      const emotionNames = emotions
        .filter((e) => selectedEmotions.includes(e.id))
        .map((e) => e.name)
      const marketConditionName = marketConditions.find((m) => m.id === marketConditionId)?.name
      const volatilityName = volatilities.find((v) => v.id === volatilityId)?.name

      // Pull historical data so the summary can flag repeat patterns, streaks,
      // day-after risk, market-condition/volatility risk, vacation re-entry
      // effects, and day-of-week trends instead of judging this day in isolation.
      const rangeStart = format(subDays(parseISO(date), 90), 'yyyy-MM-dd')
      const [analyticsRows, calendarDays] = await Promise.all([
        getAnalyticsRawData(user.id),
        getMarketCalendarDays(rangeStart, date),
      ])
      const context = getAiSummaryContext(
        analyticsRows,
        calendarDays,
        date,
        violationNames,
        emotionNames,
        marketConditionName,
        volatilityName
      )
      // Full raw text (notes, improvements, plan deviations, prior AI summaries, etc.)
      // from the last 14 logged days, so the model can check follow-through and
      // contradictions across entries — including checking its OWN prior advice —
      // instead of just narrating stats.
      const recentHistory = getRecentQualitativeHistory(analyticsRows, date, 14)

      // Screenshots from the last few TRADING days (not flat calendar days), so a
      // position opened right before a holiday/weekend cluster still gets linked to
      // today's exit instead of silently falling outside the window. Bounded to keep
      // image volume/cost sane — anything held longer than this falls back to the
      // unmatched-row handling in the prompt rather than being silently guessed at.
      const screenshotRangeStart = getScreenshotLookbackStartDate(calendarDays, date, SCREENSHOT_LOOKBACK_DAYS)
      const recentScreenshotDays = await getRecentScreenshots(user.id, screenshotRangeStart, date)
      const recentScreenshots = (
        await Promise.all(
          recentScreenshotDays.map(async (day) => {
            const shots = day.screenshots || []
            if (!shots.length) return null
            const urls = await Promise.all(shots.map((s) => getScreenshotUrl(s.storage_path)))
            return { entry_date: day.entry_date, screenshot_urls: urls }
          })
        )
      ).filter(Boolean)

      const summary = await generateAiSummary({
        entry_date: date,
        followed_rules: followedRules,
        violations: violationNames,
        emotions: emotionNames,
        market_condition: marketConditionName,
        volatility: volatilityName,
        notes,
        improvements,
        screenshot_urls: screenshots.map((s) => s.url),
        pre_max_loss: preMaxLoss === '' ? null : Number(preMaxLoss),
        pre_setups: preSetups,
        pre_mental_state: preMentalState,
        pre_notes: preNotes,
        plan_followed: planFollowed,
        plan_deviation_notes: planDeviationNotes,
        context,
        recent_history: recentHistory,
        recent_screenshots: recentScreenshots,
      })
      setAiSummary(summary)
      await ensureDayRow({ ai_summary: summary })
    } catch (err) {
      alert('Could not generate summary: ' + err.message)
    } finally {
      setGeneratingSummary(false)
    }
  }

  if (loading) return <p className="loading-note">Loading…</p>

  return (
    <div className="day-detail-page">
      <div className="day-detail-header">
        <button className="back-btn" onClick={() => navigate('/')}>
          ← Calendar
        </button>
        <h2>{format(parseISO(date), 'EEEE, MMMM d, yyyy')}</h2>
        <span className="save-indicator">
          {saving ? 'Saving…' : refreshing ? 'Loading…' : ''}
        </span>
      </div>

      <div className="vacation-toggle-row">
        <button
          type="button"
          className={`vacation-toggle-btn ${onVacation ? 'active' : ''}`}
          onClick={handleVacationToggle}
          aria-pressed={onVacation}
        >
          <span className="vacation-icon">🌴</span>
          {onVacation ? 'On Vacation' : 'Mark as Vacation'}
        </button>
      </div>

      <section className="day-section plan-section">
        <h3>Pre-Session Plan</h3>
        <p className="section-hint">Fill this out before the market opens.</p>

        <label className="field-label" htmlFor="pre-max-loss">Max loss target</label>
        <input
          id="pre-max-loss"
          type="number"
          step="any"
          inputMode="decimal"
          className="plan-number-input"
          placeholder="e.g. 300"
          value={preMaxLoss}
          onChange={(e) => setPreMaxLoss(e.target.value)}
          onBlur={(e) => handleMaxLossBlur(e.target.value)}
        />

        <label className="field-label" htmlFor="pre-setups">Setups I'm watching for</label>
        <textarea
          id="pre-setups"
          rows={2}
          value={preSetups}
          onChange={(e) => setPreSetups(e.target.value)}
          onBlur={(e) => handleTextBlur('pre_setups', e.target.value)}
          placeholder="e.g. breakout above resistance on AAPL, pullback entries on SPY"
        />

        <label className="field-label" htmlFor="pre-mental-state">Mental state going in</label>
        <input
          id="pre-mental-state"
          type="text"
          value={preMentalState}
          onChange={(e) => setPreMentalState(e.target.value)}
          onBlur={(e) => handleTextBlur('pre_mental_state', e.target.value)}
          placeholder="e.g. rested and calm, or distracted, or itching to make back yesterday's loss"
        />

        <label className="field-label" htmlFor="pre-notes">Anything else worth noting</label>
        <textarea
          id="pre-notes"
          rows={2}
          value={preNotes}
          onChange={(e) => setPreNotes(e.target.value)}
          onBlur={(e) => handleTextBlur('pre_notes', e.target.value)}
          placeholder="News, earnings, macro events to watch..."
        />
      </section>

      <section className="day-section">
        <h3>Did you follow your rules today?</h3>
        <div className="yes-no-toggle">
          <button
            className={followedRules === true ? 'active-yes' : ''}
            onClick={() => handleFollowedRules(true)}
          >
            Yes
          </button>
          <button
            className={followedRules === false ? 'active-no' : ''}
            onClick={() => handleFollowedRules(false)}
          >
            No
          </button>
        </div>

        {followedRules === false && (
          <div className="violations-block">
            <h4>Which rules were violated?</h4>
            <EditableChecklist
              items={rules}
              selectedIds={selectedViolations}
              onToggle={toggleViolation}
              onAdd={(name) => handleAddMaster('rules', setRules, name)}
              onDelete={(id) => handleDeleteMaster('rules', setRules, id)}
            />
          </div>
        )}
      </section>

      <section className="day-section">
        <h3>Emotions felt</h3>
        <EditableChecklist
          items={emotions}
          selectedIds={selectedEmotions}
          onToggle={toggleEmotion}
          onAdd={(name) => handleAddMaster('emotions', setEmotions, name)}
          onDelete={(id) => handleDeleteMaster('emotions', setEmotions, id)}
        />
      </section>

      <section className="day-section">
        <h3>Market Conditions</h3>
        <EditableDropdown
          label="Market Condition"
          items={marketConditions}
          value={marketConditionId}
          onChange={handleMarketConditionChange}
          onAdd={(name) => handleAddMaster('marketConditions', setMarketConditions, name)}
          onDelete={(id) => handleDeleteMaster('marketConditions', setMarketConditions, id)}
        />
      </section>

      <section className="day-section">
        <h3>Stock Volatility</h3>
        <p className="section-hint">Index movement vs. individual stock movement</p>
        <EditableDropdown
          label="Volatility Type"
          items={volatilities}
          value={volatilityId}
          onChange={handleVolatilityChange}
          onAdd={(name) => handleAddMaster('volatility', setVolatilities, name)}
          onDelete={(id) => handleDeleteMaster('volatility', setVolatilities, id)}
        />
      </section>

      <section className="day-section">
        <h3>Notes</h3>
        <textarea
          rows={4}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={(e) => handleTextBlur('notes', e.target.value)}
          placeholder="What happened today?"
        />
      </section>

      <section className="day-section">
        <h3>Areas for Improvement</h3>
        <textarea
          rows={4}
          value={improvements}
          onChange={(e) => setImprovements(e.target.value)}
          onBlur={(e) => handleTextBlur('improvements', e.target.value)}
          placeholder="What could you do better?"
        />
      </section>

      <section className="day-section">
        <h3>Screenshots</h3>
        <input type="file" accept="image/*" multiple onChange={handleFileUpload} />
        {uploading && <p className="loading-note">Uploading…</p>}
        <div className="screenshot-grid">
          {screenshots.map((s, idx) => (
            <div key={s.id} className="screenshot-thumb">
              <img src={s.url} alt="Trade screenshot" onClick={() => setLightboxIndex(idx)} />
              <button className="delete-x" onClick={() => handleDeleteScreenshot(s)}>
                ×
              </button>
            </div>
          ))}
        </div>
      </section>

      {lightboxIndex !== null && screenshots[lightboxIndex] && (
        <div className="lightbox-overlay" onClick={() => setLightboxIndex(null)}>
          {screenshots.length > 1 && (
            <button
              className="lightbox-nav lightbox-prev"
              onClick={(e) => {
                e.stopPropagation()
                setLightboxIndex((i) => (i - 1 + screenshots.length) % screenshots.length)
              }}
              aria-label="Previous screenshot"
            >
              ‹
            </button>
          )}

          <img
            src={screenshots[lightboxIndex].url}
            alt="Trade screenshot full size"
            className="lightbox-image"
            onClick={(e) => e.stopPropagation()}
          />

          {screenshots.length > 1 && (
            <button
              className="lightbox-nav lightbox-next"
              onClick={(e) => {
                e.stopPropagation()
                setLightboxIndex((i) => (i + 1) % screenshots.length)
              }}
              aria-label="Next screenshot"
            >
              ›
            </button>
          )}

          {screenshots.length > 1 && (
            <span className="lightbox-counter">
              {lightboxIndex + 1} / {screenshots.length}
            </span>
          )}

          <button className="lightbox-close" onClick={() => setLightboxIndex(null)}>×</button>
        </div>
      )}

      <section className="day-section plan-section">
        <h3>Post-Session Review — Plan Adherence</h3>
        <p className="section-hint">Did you stick to the plan you set above?</p>
        <div className="yes-no-toggle">
          <button
            className={planFollowed === true ? 'active-yes' : ''}
            onClick={() => handlePlanFollowed(true)}
          >
            Followed the plan
          </button>
          <button
            className={planFollowed === false ? 'active-no' : ''}
            onClick={() => handlePlanFollowed(false)}
          >
            Deviated
          </button>
        </div>

        {planFollowed === false && (
          <>
            <label className="field-label" htmlFor="plan-deviation-notes">Where did you deviate, and why?</label>
            <textarea
              id="plan-deviation-notes"
              rows={3}
              value={planDeviationNotes}
              onChange={(e) => setPlanDeviationNotes(e.target.value)}
              onBlur={(e) => handleTextBlur('plan_deviation_notes', e.target.value)}
              placeholder="e.g. planned to only trade AAPL but chased a random momentum spike in TSLA"
            />
          </>
        )}
      </section>

      <section className="day-section ai-summary-section">
        <h3>AI Summary</h3>
        <button onClick={handleGenerateSummary} disabled={generatingSummary}>
          {generatingSummary ? 'Generating…' : aiSummary ? 'Regenerate Summary' : 'Generate Summary'}
        </button>
        {aiSummary && (
          <div className="ai-summary-box">
            <FormattedSummary text={aiSummary} />
          </div>
        )}
      </section>
    </div>
  )
}
