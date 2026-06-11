// Live poll — runs every 15 minutes.
//
// Reads data/events.json (built by the catalog scan) and polls only leagues
// that have an event live now or starting within 20 minutes. When nothing
// qualifies it exits in seconds with changed=false and no deploy happens.
//
// Updated scores are merged into the previously published manifest (fetched
// back from GitHub Pages), so dormant leagues' data is preserved between
// catalog runs.

import {
  dateUTC, fetchJSON, fetchScoreboard, pool,
  mergeScoreboards, upsertEvents, indexEvents, sortLeagues,
  readJSON, writeJSON, setOutput, writeSite,
} from "./lib.mjs"

const SOON_MS  = 20 * 60_000        // poll leagues with games starting within 20 min
const STALE_MS = 12 * 3600_000      // ignore "pre" events whose start is >12 h past (postponed/zombie)

const index = readJSON("data/events.json")
if (!index) {
  console.log("no data/events.json — run the catalog workflow first")
  setOutput("changed", "false")
  process.exit(0)
}

// ─── Which (league, date) pairs need a poll? ─────────────────────────────────

const nowMs = Date.now()
const minDate = dateUTC(-1), maxDate = dateUTC(1)
const targets = []

for (const league of Object.values(index.leagues)) {
  const pollDates = new Set()
  for (const ev of league.events) {
    if (ev.state === "post" || !ev.start) continue
    const startMs = new Date(ev.start).getTime()
    const live = ev.state === "in"
    const imminent = startMs <= nowMs + SOON_MS && startMs >= nowMs - STALE_MS
    if (!live && !imminent) continue
    // Fetch the event's own UTC date (clamped to the window) — handles games
    // just past UTC midnight that today's scoreboard wouldn't include. For
    // live multi-day tournaments, also fetch today.
    let d = ev.start.slice(0, 10)
    if (d < minDate || d > maxDate || live) d = dateUTC(0)
    pollDates.add(d)
  }
  if (pollDates.size > 0) {
    targets.push({ sport: league.sport, slug: league.slug, dates: [...pollDates] })
  }
}

if (targets.length === 0) {
  console.log("nothing live or starting soon — skipping")
  setOutput("changed", "false")
  process.exit(0)
}

console.log(`polling ${targets.length} leagues: ${targets.map(t => `${t.sport}/${t.slug}`).join(", ")}`)

// ─── Load the previously published manifest ──────────────────────────────────

const pagesURL = process.env.PAGES_URL ?? "https://bemasiero.github.io/sss-data"
let manifest = null
try {
  manifest = await fetchJSON(`${pagesURL}/manifest.json?cb=${Date.now()}`)
} catch (err) {
  console.warn(`could not fetch published manifest: ${err.message}`)
}

if (!manifest || !Array.isArray(manifest.leagues) || manifest.leagues.length === 0) {
  // Publishing now would produce a manifest containing only live leagues and
  // drop everything else. Bail and let the next catalog run publish first.
  console.log("no published manifest to merge into — skipping until catalog runs")
  setOutput("changed", "false")
  process.exit(0)
}

const byKey = new Map(manifest.leagues.map(l => [`${l._meta?.sport}/${l._meta?.slug}`, l]))

// ─── Poll & merge ─────────────────────────────────────────────────────────────

let polled = 0, errors = 0

await pool(targets, 10, async target => {
  const key = `${target.sport}/${target.slug}`
  for (const d of target.dates) {
    try {
      const data = await fetchScoreboard(target.sport, target.slug, d)
      polled++
      if (!data) continue
      const existing = byKey.get(key)
      if (existing) {
        upsertEvents(existing, data.events)
      } else {
        const fresh = mergeScoreboards(target.sport, target.slug, [data])
        if (fresh) byKey.set(key, fresh)
      }
    } catch (err) {
      errors++
      console.warn(`poll failed for ${key} ${d}: ${err.message}`)
    }
  }
  // Refresh the schedule index so finished games stop triggering polls.
  const payload = byKey.get(key)
  if (payload && index.leagues[key]) index.leagues[key].events = indexEvents(payload)
})

manifest.leagues = sortLeagues([...byKey.values()])
manifest.updatedAt = new Date().toISOString()

writeSite(manifest)
writeJSON("data/events.json", index, true)

console.log(`done: ${polled} fetches (${errors} errors), manifest updated`)
setOutput("changed", "true")
