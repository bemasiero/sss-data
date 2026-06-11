// Catalog scan — runs 2×/day (00:25 / 12:25 UTC).
//
// Fetches every league in the registry for D-1, D, D+1 (UTC), builds:
//   site/manifest.json  — full app manifest (deployed to GitHub Pages)
//   data/events.json    — compact schedule index for the live poller (committed)
//   data/registry.json  — league registry state (committed)
//
// League discovery (ESPN core API) runs on Sunday's early run, or when
// dispatched manually with discover=true.

import {
  ESPN_CORE, dateUTC, fetchJSON, fetchScoreboard, pool,
  mergeScoreboards, indexEvents, sortLeagues, readJSON, writeJSON, writeSite,
} from "./lib.mjs"

const seed = readJSON("data/seed.json")
const registry = readJSON("data/registry.json", {})

const freshEntry = (sport, slug) => ({
  sport, slug, name: null, status: "UNKNOWN", maxEventDate: null, lastChecked: null,
})

for (const { sport, slug } of seed.leagues) {
  registry[`${sport}/${slug}`] ??= freshEntry(sport, slug)
}

// ─── Discovery ────────────────────────────────────────────────────────────────

const now = new Date()
const isSundayEarly = now.getUTCDay() === 0 && now.getUTCHours() < 6
const discover =
  process.env.DISCOVER === "true" ||
  (process.env.GITHUB_EVENT_NAME === "schedule" && isSundayEarly)

if (discover) {
  console.log("running league discovery…")
  let added = 0
  for (const sport of seed.sports) {
    try {
      const data = await fetchJSON(`${ESPN_CORE}/sports/${sport}/leagues?limit=1000`)
      for (const item of data?.items ?? []) {
        const slug = (item.$ref ?? item.ref ?? "").split("?")[0].split("/").pop()
        if (!slug) continue
        const key = `${sport}/${slug}`
        if (!registry[key]) { registry[key] = freshEntry(sport, slug); added++ }
      }
    } catch (err) {
      console.warn(`discovery failed for ${sport}: ${err.message}`)
    }
  }
  console.log(`discovery added ${added} leagues`)
}

// ─── Full scan: every league × D-1, D, D+1 ───────────────────────────────────

const dates = [dateUTC(-1), dateUTC(0), dateUTC(1)]
const leagues = Object.values(registry)
console.log(`scanning ${leagues.length} leagues × [${dates.join(", ")}]`)

const manifestLeagues = []
const eventsIndex = {}
let fetched = 0, errors = 0

await pool(leagues, 12, async entry => {
  const payloads = []
  for (const d of dates) {
    try {
      payloads.push(await fetchScoreboard(entry.sport, entry.slug, d))
      fetched++
    } catch {
      errors++
      payloads.push(null)
    }
  }

  entry.lastChecked = new Date().toISOString()
  const merged = mergeScoreboards(entry.sport, entry.slug, payloads)
  if (!merged) return

  entry.name = merged._meta.name
  const events = indexEvents(merged)
  const maxDate = events.reduce((m, ev) => ((ev.start ?? "") > m ? ev.start : m), "")
  if (maxDate) entry.maxEventDate = maxDate.slice(0, 10)

  const inWindow = events.some(ev => {
    const d = (ev.start ?? "").slice(0, 10)
    return d >= dates[0] && d <= dates[2]
  })
  entry.status = inWindow ? "ACTIVE" : "DORMANT"

  if (inWindow) {
    manifestLeagues.push(merged)
    eventsIndex[`${entry.sport}/${entry.slug}`] = {
      sport: entry.sport, slug: entry.slug, name: entry.name, events,
    }
  }
})

// ─── Outputs ──────────────────────────────────────────────────────────────────

const manifest = { updatedAt: new Date().toISOString(), leagues: sortLeagues(manifestLeagues) }
const { bytes, events } = writeSite(manifest)

writeJSON("data/registry.json", registry, true)
writeJSON("data/events.json", {
  generatedAt: manifest.updatedAt,
  window: dates,
  leagues: eventsIndex,
}, true)

console.log(`done: ${fetched} fetches (${errors} errors), ` +
  `${manifest.leagues.length} leagues in manifest, ${events} events, ` +
  `${(bytes / 1048576).toFixed(1)} MB`)
