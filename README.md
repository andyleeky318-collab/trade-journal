# Trade Journal

A behavior-over-outcome trading discipline journal. Tracks rule adherence,
emotions, market conditions, and pre/post-session planning — deliberately
*not* P&L. AI-generated daily and weekly/monthly summaries surface behavioral
patterns over time, without ever printing a dollar figure.

**Full setup instructions are in `Trade-Journal-Setup-Guide.docx`** (or the
copy shared alongside this repo) — start there. It walks through every step,
browser-only, from creating the Supabase project to your first journal entry.

## What's in this repo

- `src/` — the React app (Vite + React Router + Supabase JS + Recharts)
- `sql/schema.sql` — the full database schema, run once in Supabase's SQL Editor
- `supabase/functions/` — four Edge Functions (`ai-summary`, `rollup-summary`,
  `github-backup`, `market-calendar-sync`)
- `.github/workflows/` — GitHub Actions for backups, restores, and the weekly
  market calendar sync
- `cloudflare-workers/` — two optional, self-contained Cloudflare Workers for
  automated daily backups and session reminders (no Supabase cron required)

## Core features

- Daily entry: rule violations, emotions, market conditions, volatility,
  notes, multi-screenshot upload with lightbox, pre-session plan, post-session
  review, vacation/holiday marking
- AI-generated daily summaries with historical pattern context (streaks,
  day-of-week trends, emotion correlation, cross-day trade-log linking)
- AI-generated weekly/monthly rollup summaries
- Analytics dashboard: rolling adherence, rule/emotion frequency and trend,
  co-violation pairs, emotion×rule heatmap, day-after effect, journaling
  consistency — all trading-calendar-aware once the market calendar is synced
- Calendar view with check/✕/vacation-palm-tree day indicators
- One-click backup & restore via GitHub Releases, triggered from an in-app panel
- Optional automated daily backups + pre/post-session Pushover reminders via
  Cloudflare Workers

## Stack

React 19 · Vite · React Router 7 · Recharts · date-fns · Supabase (Postgres,
Auth, Edge Functions, Storage) · OpenAI (gpt-4o-mini) · Alpaca (market
calendar, optional) · Pushover (notifications, optional) · GitHub Pages +
Actions

## License

Use this however you'd like for your own trading journal.
