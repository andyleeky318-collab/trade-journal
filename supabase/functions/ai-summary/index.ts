// Supabase Edge Function: ai-summary
// Deploy via the Supabase dashboard editor (Edge Functions > ai-summary > paste & deploy).
// Set your OpenAI key first: supabase secrets set OPENAI_API_KEY=sk-...
//
// This function receives the day's journal data (+ optional screenshot image URLs
// for today, + screenshots from the prior N logged trading days via
// "recent_screenshots" — enabling entry/exit linking across days instead of
// same-day-only round-trips — + optional historical "context" from
// getAiSummaryContext, + "recent_history" — full raw text from the last 14 logged
// days, including each day's own prior AI summary — from
// getRecentQualitativeHistory) and returns an AI-generated summary. The OpenAI
// key never touches the browser.
//
// Screenshots (today's + the prior trading days') are treated as a first-class
// data source: if any of the images look like a trade log / broker execution
// history, the model reconstructs round-trips across ALL provided days (not just
// today), flags behavioral patterns (re-entries, escalating/shrinking losses,
// size creep, revenge-trade timing, multi-day holds), and closes with a pointed
// self-reflection question. Per an explicit design decision, dollar P&L figures
// are NEVER printed in the output — the model may compute P&L internally to
// judge magnitude and direction (bigger loss, smaller loss, roughly breakeven,
// a gain) but must describe outcomes qualitatively only, keeping the journal's
// focus on behavior rather than performance.
//
// `context` gives the model numeric/statistical grounding (repeat-pattern ranks,
// emotion-violation correlation, market-condition/volatility risk, streaks,
// day-after risk, day-of-week trend, weekly rollup, vacation-return status).
// `recent_history` gives it the actual raw text of the last 14 days' notes,
// improvements, plan deviations, and its own prior AI summaries, and it's
// explicitly instructed to reason across that text — checking follow-through
// (both the trader's own and its own prior advice), flagging contradictions,
// distinguishing a genuinely recurring root cause from a same-label-different-
// trigger coincidence, judging plan fidelity beyond a yes/no, and treating a
// post-vacation day as possible rust rather than a resumed discipline pattern.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function pct(x: number | null | undefined) {
  return x === null || x === undefined ? "n/a" : `${Math.round(x * 100)}%`;
}

function buildContextBlock(context: any): string {
  if (!context) return "";
  const lines: string[] = [];

  if (context.violationPatterns?.length) {
    lines.push("Rule violations logged today, with their history before today:");
    for (const v of context.violationPatterns) {
      const rankNote = v.rank ? `, ranked #${v.rank} most frequent violation overall` : ", no prior occurrences";
      const patternNote = v.isTopPattern ? " — this is a recurring top pattern, not a one-off" : "";
      lines.push(`- "${v.name}": ${v.priorCount} prior occurrence(s)${rankNote}${patternNote}`);
    }
  }

  if (context.emotionPatterns?.length) {
    lines.push("Emotions felt today, with their historical link to rule violations:");
    for (const e of context.emotionPatterns) {
      if (e.violationRate === null) {
        lines.push(`- "${e.name}": not enough prior data to correlate yet`);
      } else {
        const deltaPts = Math.round((e.delta ?? 0) * 100);
        const sign = deltaPts >= 0 ? "+" : "";
        lines.push(
          `- "${e.name}": historically ${pct(e.violationRate)} violation rate vs ${pct(e.baselineViolationRate)} baseline (${sign}${deltaPts} points)`
        );
      }
    }
  }

  if (context.marketConditionPattern) {
    const mc = context.marketConditionPattern;
    lines.push(
      `Today's market condition ("${mc.name}") has historically had a ${pct(mc.violationRate)} violation rate (n=${mc.total}).`
    );
  }

  if (context.volatilityPattern) {
    const v = context.volatilityPattern;
    lines.push(
      `Today's volatility type ("${v.name}") has historically had a ${pct(v.violationRate)} violation rate (n=${v.total}).`
    );
  }

  if (context.previousDay) {
    lines.push(
      `Most recent prior logged day (${context.previousDay.date}) was a ${context.previousDay.followedRules ? "clean" : "rule-violation"} day.`
    );
  }

  if (context.dayAfterEffect && (context.dayAfterEffect.afterViolationSample > 0 || context.dayAfterEffect.afterCleanSample > 0)) {
    lines.push(
      `Historically, after a violation day this trader violates rules again ${pct(context.dayAfterEffect.afterViolationRate)} of the time (n=${context.dayAfterEffect.afterViolationSample}), vs. ${pct(context.dayAfterEffect.afterCleanRate)} after a clean day (n=${context.dayAfterEffect.afterCleanSample}).`
    );
  }

  if (context.streaks) {
    lines.push(
      `Rule-following streak entering today: ${context.streaks.current} day(s) (longest streak on record: ${context.streaks.longest} day(s)).`
    );
  }

  if (context.rollingAdherence) {
    lines.push(
      `Rolling adherence entering today — last 7 days: ${pct(context.rollingAdherence.d7)}, last 30 days: ${pct(context.rollingAdherence.d30)}.`
    );
  }

  if (context.dayOfWeek && context.dayOfWeek.sample > 0) {
    lines.push(
      `${context.dayOfWeek.day}s have historically had a ${pct(context.dayOfWeek.violationRate)} violation rate (n=${context.dayOfWeek.sample}).`
    );
  }

  if (context.weeklyRollup && context.weeklyRollup.daysLogged > 0) {
    lines.push(
      `So far this week (before today): ${context.weeklyRollup.daysLogged} day(s) logged, top violation "${context.weeklyRollup.topViolation ?? "none"}", top emotion "${context.weeklyRollup.topEmotion ?? "none"}".`
    );
  }

  if (context.vacationContext?.returningFromVacation) {
    const vc = context.vacationContext;
    lines.push(
      `This entry immediately follows ${vc.vacationDaysBeforeEntry} marked vacation day(s) (most recent: ${vc.lastVacationDate}). Treat a rough day here as a POSSIBLE re-entry/rust effect, not automatically as a resumed discipline pattern — don't let it inflate a "recurring pattern" claim on its own.`
    );
  }

  if (!lines.length) return "";
  return `\n--- Pattern Context (computed from entries before today — use this to say whether today is a recurring pattern or a departure from one, not just to restate today's numbers) ---\n${lines.join("\n")}\n`;
}

function buildRecentHistoryBlock(recentHistory: any[]): string {
  if (!recentHistory || recentHistory.length === 0) return "";

  const dayBlocks = recentHistory.map((d) => {
    const parts: string[] = [`Date: ${d.entry_date}`];
    if (d.on_vacation) parts.push(`(Marked as a vacation day)`);
    parts.push(`Followed rules: ${d.followed_rules === null ? "not specified" : d.followed_rules ? "Yes" : "No"}`);
    if (d.violations?.length) parts.push(`Violations: ${d.violations.join(", ")}`);
    if (d.emotions?.length) parts.push(`Emotions: ${d.emotions.join(", ")}`);
    if (d.market_condition) parts.push(`Market condition: ${d.market_condition}`);
    if (d.pre_mental_state) parts.push(`Pre-session mental state (stated): "${d.pre_mental_state}"`);
    if (d.pre_setups) parts.push(`Pre-session setups watched for: "${d.pre_setups}"`);
    if (d.pre_notes) parts.push(`Pre-session notes: "${d.pre_notes}"`);
    if (d.notes) parts.push(`Session notes: "${d.notes}"`);
    if (d.improvements) parts.push(`Self-identified improvement area: "${d.improvements}"`);
    parts.push(`Followed pre-session plan: ${d.plan_followed === null ? "not specified" : d.plan_followed ? "Yes" : "No"}`);
    if (d.plan_deviation_notes) parts.push(`Plan deviation notes: "${d.plan_deviation_notes}"`);
    if (d.ai_summary) {
      parts.push(
        `Previous AI summary generated for this day (its closing "actionable takeaway for tomorrow" is what you should check for follow-through against later days, including today):\n"""\n${d.ai_summary}\n"""`
      );
    }
    return parts.join("\n");
  });

  return `\n--- Full Journal Text, Last 14 Logged Days Before Today (oldest to newest) ---
This is the trader's own raw text from each prior day, plus the AI summary (including
its closing actionable takeaway) that was generated for that day, if any. Read all of
it and reason across days — this is where the real analytical work happens, not just
in today's entry.

${dayBlocks.join("\n\n")}
`;
}

// Builds the ordered list of { type: "text" | "image_url", ... } content blocks for
// screenshots across recent_screenshots (oldest first) + today, each preceded by a
// clear date label so the model can attempt to link a BUY on one day to a SELL on
// a later day within this window, rather than only ever reading same-day activity.
function buildScreenshotContent(
  recentScreenshots: { entry_date: string; screenshot_urls: string[] }[],
  todayDate: string,
  todayUrls: string[]
): { blocks: any[]; hasAnyScreenshots: boolean; screenshotDatesDescription: string } {
  const blocks: any[] = [];
  const datesInvolved: string[] = [];

  for (const day of recentScreenshots || []) {
    if (!day.screenshot_urls?.length) continue;
    datesInvolved.push(day.entry_date);
    blocks.push({ type: "text", text: `--- Screenshots from account activity on ${day.entry_date} (prior day, for cross-day linking) ---` });
    for (const url of day.screenshot_urls.slice(0, 4)) {
      blocks.push({ type: "image_url", image_url: { url, detail: "high" } });
    }
  }

  if (todayUrls.length) {
    datesInvolved.push(todayDate);
    blocks.push({ type: "text", text: `--- Screenshots from today, ${todayDate} ---` });
    for (const url of todayUrls.slice(0, 6)) {
      blocks.push({ type: "image_url", image_url: { url, detail: "high" } });
    }
  }

  return {
    blocks,
    hasAnyScreenshots: datesInvolved.length > 0,
    screenshotDatesDescription: datesInvolved.join(", "),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      entry_date,
      followed_rules,
      violations = [],
      emotions = [],
      market_condition,
      volatility,
      notes,
      improvements,
      screenshot_urls = [],
      pre_max_loss,
      pre_setups,
      pre_mental_state,
      pre_notes,
      plan_followed,
      plan_deviation_notes,
      context = null,
      recent_history = [],
      recent_screenshots = [],
    } = await req.json();

    const { blocks: screenshotBlocks, hasAnyScreenshots, screenshotDatesDescription } = buildScreenshotContent(
      recent_screenshots,
      entry_date,
      screenshot_urls
    );
    const contextBlock = buildContextBlock(context);
    const historyBlock = buildRecentHistoryBlock(recent_history);
    const hasEnoughHistory = recent_history.length >= 3;

    const promptText = `You are a trading psychology coach reviewing a trader's daily journal entry.
You are not a note-taker — your job is analysis, not transcription. Anywhere you can
compare today against the trader's own words (or your own prior advice) from prior
days, do that instead of just restating what they entered today.

--- Formatting rules (follow exactly) ---
Respond using only this lightweight markdown, since it gets rendered directly:
- "## " at the start of a line for a section header (e.g. "## Trade Log Review", "## Journal Notes")
- "- " at the start of a line for a bullet point
- "**text**" to bold a key phrase, figure, or symbol
- Plain lines for normal paragraphs
Do NOT use markdown tables, numbered headers like "1)", horizontal rules, or code blocks.
Keep paragraphs short (2-4 sentences). Prefer bullets over long paragraphs when listing
multiple trades, patterns, or takeaways.

--- CRITICAL: no dollar P&L figures, anywhere ---
Never print a dollar profit/loss amount, in any form — not per-trade, not a daily
total, not a rough estimate, not in a parenthetical. This app is deliberately built
around behavior and process rather than performance, and dollar figures in the output
would work against that. You MAY silently compute or estimate P&L internally to judge
things like whether losses grew across re-entries, or whether a day was net positive
or negative — but describe all of that in words only: "a modest loss," "a larger loss
than the previous attempt," "roughly breakeven," "a solid gain," "losses grew across
the three re-entries," "a net losing day." If you catch yourself about to write a "$"
followed by a number that represents an outcome, rewrite it as a qualitative
description instead.

${hasAnyScreenshots ? `--- Trade Log Screenshots (${screenshotDatesDescription}) ---
You've been given screenshots spanning multiple days (labeled by date above each
group of images). One or more images on any of these days may be a broker trade log
/ execution history (rows showing ticker, BOUGHT/SOLD, share count, price, and a
timestamp). If you see this kind of data, do the following:

1. Read every row directly from the image(s) — do not guess or estimate figures you
   can't actually see.
2. Group executions by ticker ACROSS ALL PROVIDED DAYS, not just within a single day,
   and reconstruct each round-trip (entry -> exit) in chronological order, even if the
   entry and exit appear in screenshots from different dates.
3. For each round-trip, list it as a bullet noting the symbol, approximate entry
   price, exit price, share size, and how many days it was held if it spanned more
   than one day — but describe the outcome qualitatively per the no-dollar-figures
   rule above (e.g. "- **DELL**, opened ${screenshotDatesDescription.split(",")[0] || "day 1"}, closed same day: a small loss" or
   "- **AAPL**, opened on [date], held 2 days, closed on [date]: roughly breakeven").
4. If a BUY row has no matching SELL anywhere in the provided screenshots (and vice
   versa), do NOT guess at the missing side. State plainly that the position appears
   to still be open as of the most recent screenshot available, or that an exit
   appears in the images with no visible entry in this window — don't fabricate a
   price or date for the missing leg.
5. Identify patterns across the full window (not just one day):
   - Multiple separate entries on the same symbol across the days shown (re-entry /
     "revenge" risk) — call out how many attempts and whether losses appeared to grow,
     shrink, or stay flat across those attempts, in qualitative terms only.
   - Whether the trader averaged down (added size to a position that was already
     open and losing) vs. fully closing before re-entering.
   - Position size consistency or creep across entries (sizing up after a loss).
   - Timing patterns — did a new entry follow a loss within minutes or hours
     (possible revenge trade), or was there a cooling-off gap?
   - Multi-day holds specifically: if a position spanned more than one day, note
     the hold duration and, if the trader's notes/emotions on the days in between
     are available elsewhere in this prompt, whether the entry's stated plan
     ("quick scalp," "swing play," etc.) matches how long it was actually held.
   - Symbols that were cut once and never re-touched (a positive discipline signal
     worth naming).
6. Close the trade-log portion with ONE direct, specific question aimed at the
   trader's intent on the symbol with the most re-entries or the longest unplanned
   hold — something in the spirit of "did each entry have new evidence, or were you
   trying to prove the first one right?"

If none of the images contain a readable trade log, skip this section entirely and
say nothing about it (do not mention that a trade log was expected or missing).
` : ""}${contextBlock}${historyBlock}
--- Today's Entry ---
Date: ${entry_date}

Pre-Session Plan:
Max loss target: ${pre_max_loss === null || pre_max_loss === undefined ? "not specified" : pre_max_loss}
Setups watching for: ${pre_setups || "not specified"}
Mental state going in: ${pre_mental_state || "not specified"}
Other pre-session notes: ${pre_notes || "none"}

Session Outcome:
Followed rules: ${followed_rules === null ? "not specified" : followed_rules ? "Yes" : "No"}
Rule violations: ${violations.length ? violations.join(", ") : "none"}
Emotions felt: ${emotions.length ? emotions.join(", ") : "none noted"}
Market condition: ${market_condition || "not specified"}
Volatility: ${volatility || "not specified"}
Notes: ${notes || "none"}
Areas for improvement (self-noted): ${improvements || "none"}

Post-Session Review:
Followed the pre-session plan: ${plan_followed === null || plan_followed === undefined ? "not specified" : plan_followed ? "Yes" : "No, deviated"}
Deviation notes: ${plan_deviation_notes || "none"}

--- Required: "## Pattern Analysis" section ---
${hasEnoughHistory ? `Using the full journal text above from the last 14 logged days, include a "## Pattern Analysis"
section that does genuine analytical work, not recap. Specifically:

1. **Follow-through check (self-stated)**: Find any "improvement area" or stated
   intention from a prior day. Check whether today's entry shows that intention being
   honored or broken. Name the date it was first stated and what happened today in
   relation to it. If there's nothing to check, say so briefly rather than forcing a
   match.
2. **Follow-through check (your own prior advice)**: Each prior day's "Previous AI
   summary" text above ends with an actionable takeaway you gave at the time. Check
   whether that specific advice shows up as honored or ignored in today's entry (or
   in the days between then and now). Be specific about which day's advice you're
   referencing and what actually happened.
3. **Contradiction check**: Compare today's stated pre-session mental state against
   today's actual emotions/outcome, AND compare today's stated plan/intentions against
   what plan_deviation_notes or session notes say actually happened. Name any
   meaningful gap directly.
4. **Same cause vs. different trigger**: If today's violation(s) repeat something from
   the last 14 days, use the actual notes text to judge whether this looks like the
   SAME underlying cause recurring or a DIFFERENT situation that happens to share a
   label. Factor in the market-condition/volatility risk noted in Pattern Context
   above if relevant. State which scenario it looks like and why, citing specifics.
5. **Plan fidelity, beyond yes/no**: Compare what was stated in "Setups watching for"
   against what the session notes and violations actually describe. Distinguish
   between: (a) the trader abandoned the plan for a genuinely different setup or
   symbol, vs. (b) the trader's reasoning stayed roughly on-plan but a specific rule
   got broken along the way. Name which one this looks like.
6. **Vacation-adjusted framing**: If Pattern Context above flags this entry as
   following marked vacation day(s), explicitly consider whether today's outcome
   looks like ordinary re-entry rust versus a genuine resumption of a pre-existing
   pattern. Don't count a single post-vacation day as strong evidence either way.
7. **Language/trigger patterns**: If the trader's own phrasing repeats across entries,
   name the pattern in your own words — don't just quote it back.

Keep inferences grounded in what's actually written. If the sample is thin or
ambiguous on a given point, say that plainly rather than overstating confidence.` : `There isn't enough logged history yet (fewer than 3 prior days in the last 14) to do
a meaningful cross-day Pattern Analysis. Skip this section entirely rather than
forcing conclusions from too little data.`}

End with one actionable takeaway for tomorrow, informed by the trade log (if present), today's entry, the pattern context, and — most importantly — the Pattern Analysis above. Remember: no dollar figures anywhere in your response, including in this closing takeaway.`;

    const content: any[] = [{ type: "text", text: promptText }, ...screenshotBlocks];

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content }],
        max_tokens: 2200,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: errText }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const summary = data.choices?.[0]?.message?.content ?? "No summary generated.";

    return new Response(JSON.stringify({ summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
