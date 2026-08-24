// Generic localStorage cache helpers for the "stale-while-revalidate" pattern
// used across Calendar, DayDetail, and Analytics: render whatever's cached
// immediately (no loading wait on repeat visits), then always refetch in the
// background and swap in anything that changed.
//
// This is purely an optimization layer — every page that uses it still runs
// its normal, full network fetch every time it loads. The cache only affects
// what's shown *while that fetch is in flight*. Any failure to read, parse,
// or write the cache falls back to the page's existing loading state, never
// to incorrect data being trusted as final.
//
// Persists across app closes (including iOS Home Screen PWAs, which are
// exempt from Safari's 7-day ITP storage-clearing timer) — important given
// this app is opened/closed frequently throughout the day rather than kept
// running continuously.
const CACHE_PREFIX = 'tj_cache_v1_'

export function readCache(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function writeCache(key, value) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value))
  } catch {
    // localStorage can fail (Safari private mode, quota exceeded, etc.) —
    // caching is a pure optimization, so just skip it silently.
  }
}

export function clearCache(key) {
  try {
    localStorage.removeItem(CACHE_PREFIX + key)
  } catch {
    // ignore
  }
}
