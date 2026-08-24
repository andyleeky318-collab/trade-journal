// Supabase Edge Function: rollup-summary
// Deploy via the Supabase dashboard editor (Edge Functions > rollup-summary > paste & deploy).
// Uses the same OPENAI_API_KEY secret as the ai-summary function — no extra setup needed
// if you've already deployed that one.
//
// Takes aggregate stats for a week or month (adherence rate, top violations/emotions,
// plan adherence) plus the individual daily ai_summary texts already generated for that
// period, and writes a period-level synthesis: the throughline pattern, best/worst day,
// whether the numbers match the trader's own narrative, period-over-period trajectory
// (if previous-period stats are supplied), and a required "What to Improve Next
// [Period]" section naming the single biggest concern and concrete fixes for it.
//
// Per the same design decision as ai-summary, dollar P&L figures are never printed in
// the output — daily_summaries text may occasionally contain historical figures from
// before that rule existed, so this function explicitly instructs the model to never
// echo or reference any dollar amount it encounters, even if quoting from a daily
// summary that has one.
//
// No images here — this is text-only synthesis of data already gathered client-side.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function pct(x: number | null | undefined) {
  return x === null || x === undefined ? "not enough data" : `${Math.round(x * 100)}%`;
}

// Builds a plain-language period-over-period comparison line for a single metric,
// or returns null if either value is unavailable. Kept qualitative-friendly (the
// model still gets the raw percentages so it can describe direction and size of
// the shift in its own words) rather than trying to pre-compute a delta phrase here.
function buildComparisonLine(label: string, current: number | null | undefined, previous: number | null | undefined): string | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  return `${label}: ${pct(current)} this period vs ${pct(previous)} last period`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      period_type, // 'week' | 'month'
      period_label, // e.g. "Week of July 6, 2026" or "July 2026"
      days_logged,
      total_days_in_period,
      adherence, // 0-1 or null
      plan_adherence, // 0-1 or null
      top_violations = [], // [{ name, count }]
      top_emotions = [], // [{ name, count }]
      daily_summaries = [], // [{ date, summary }]
      // Optional: same shape as the current-period fields above, but for the
      // immediately preceding period of the same length. Any/all may be omitted
      // if the previous period has no data (e.g. this is the trader's first
      // logged week/month) — comparison lines are simply skipped when absent.
      previous_days_logged,
      previous_total_days_in_period,
      previous_adherence,
      previous_plan_adherence,
    } = await req.json();

    const periodNoun = period_type === "month" ? "month" : "week";

    const violationsList = top_violations.length
      ? top_violations.map((v: any) => `${v.name} (${v.count}x)`).join(", ")
      : "none logged";
    const emotionsList = top_emotions.length
      ? top_emotions.map((e: any) => `${e.name} (${e.count}x)`).join(", ")
      : "none logged";

    // Full daily summary text is included — no truncation. Token cost isn't a
    // constraint here, and each day's own "## Pattern Analysis" section and
    // closing takeaway is the most useful part of each summary to synthesize
    // across, so it's worth passing along in full.
    const dailyBlock = daily_summaries.length
      ? daily_summaries
          .map((d: any) => `--- ${d.date} ---\n${d.summary || "(no summary text)"}`)
          .join("\n\n")
      : `None of the individual days in this ${periodNoun} have a generated AI summary yet — base the review on the aggregate stats below only.`;

    const comparisonLines = [
      buildComparisonLine("Rule adherence", adherence, previous_adherence),
      buildComparisonLine("Plan adherence", plan_adherence, previous_plan_adherence),
    ].filter(Boolean);

    if (
      days_logged !== undefined &&
      previous_days_logged !== undefined &&
      previous_days_logged !== null &&
      total_days_in_period !== undefined &&
      previous_total_days_in_period !== undefined &&
      previous_total_days_in_period !== null
    ) {
      comparisonLines.push(
        `Days journaled: ${days_logged} of ${total_days_in_period} this period vs ${previous_days_logged} of ${previous_total_days_in_period} last period`
      );
    }

    const comparisonBlock = comparisonLines.length
      ? `\n--- Compared to the Previous ${periodNoun === "month" ? "Month" : "Week"} ---\n${comparisonLines.join("\n")}\n`
      : "";

    const promptText = `You are a trading psychology coach writing a ${periodNoun}ly rollup review: "${period_label}".

--- Formatting rules (follow exactly) ---
Respond using only this lightweight markdown, since it gets rendered directly:
- "## " at the start of a line for a section header
- "- " at the start of a line for a bullet point
- "**text**" to bold a key phrase, figure, or symbol
- Plain lines for normal paragraphs
Do NOT use markdown tables, numbered headers like "1)", horizontal rules, or code blocks.
Keep paragraphs short (2-4 sentences). Prefer bullets over long paragraphs when listing patterns.

--- CRITICAL: no dollar P&L figures, anywhere ---
Never print a dollar profit/loss amount, in any form — not per-trade, not a period
total, not a rough estimate. This app is deliberately built around behavior and
process rather than performance. Some of the daily summaries below were generated
before this rule existed and may contain a dollar figure — if you see one while
reading them, do NOT repeat, quote, or reference it. Describe any outcome you're
drawing on qualitatively instead ("a losing stretch," "a strong day," "the loss grew
across re-entries"). If you catch yourself about to write a "$" followed by a number,
rewrite it as a qualitative description instead.

--- Aggregate Stats ---
Days journaled: ${days_logged} of ${total_days_in_period} possible ${periodNoun === "month" ? "calendar" : "trading"} days
Rule adherence rate: ${pct(adherence)}
Pre-session plan adherence rate: ${pct(plan_adherence)}
Most frequent rule violations: ${violationsList}
Most frequent emotions: ${emotionsList}
${comparisonBlock}
--- Individual Daily Summaries This ${periodNoun === "month" ? "Month" : "Week"} ---
${dailyBlock}

--- Your task ---
Write a ${periodNoun}-level synthesis, not a rehash of each day. Specifically:
- Identify the throughline: is there one behavioral pattern (an emotion, a type of rule
  break, a recurring symbol/setup) that shows up repeatedly across the period? Draw on
  the daily summaries' own "Pattern Analysis" and closing takeaway sections where
  present — they often already contain useful per-day findings worth synthesizing
  across, not just the raw stats.
- If the daily summaries make it clear, call out the best day and the worst day, and why.
- Compare this period's discipline to what the stats show — does the trader's own daily
  narrative match the numbers, or is there a mismatch worth flagging (e.g. "followed rules"
  most days but adherence rate says otherwise, or vice versa)?
${comparisonLines.length ? `- Use the period-over-period comparison above explicitly: say whether things are trending better, worse, or flat, and by how much in plain terms (not just restating the percentages).` : ""}

--- Required: "## What to Improve Next ${periodNoun === "month" ? "Month" : "Week"}" section ---
Include this as the final section, always. Identify the SINGLE biggest area of concern
from this period — not a list of everything that went wrong, just the one issue that
matters most, chosen using whatever combination of the stats, the throughline pattern,
and the daily summaries' own content best supports it. Then:
- State plainly why this is the biggest concern (not just "it happened most" — explain
  the reasoning, e.g. it's worsening, it's tied to your largest rule violations, or it
  contradicts a stated intention repeatedly).
- Propose 1-2 concrete, specific fixes for it — something actionable the trader could
  actually do differently next ${periodNoun}, not generic advice like "be more
  disciplined." Ground the suggestion in what the daily summaries show about when/why
  this pattern tends to occur, if that's discernible.
- Keep this section tight — a few sentences of reasoning plus the fix(es), not an essay.

Keep the overall response tight — this is a scan-friendly review, not an essay.`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: promptText }],
        max_tokens: 1400,
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
