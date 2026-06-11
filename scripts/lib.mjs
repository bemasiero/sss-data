import fs from "node:fs"
import path from "node:path"

export const ESPN_SITE = "https://site.api.espn.com/apis/site/v2"
export const ESPN_CORE = "https://sports.core.api.espn.com/v2"

// ─── Dates ────────────────────────────────────────────────────────────────────

export function dateUTC(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10)
}

export const yyyymmdd = iso => iso.replaceAll("-", "")

// ─── HTTP ─────────────────────────────────────────────────────────────────────

// Returns parsed JSON, or null for 400/404 (league/date doesn't exist upstream).
// Retries transient failures with backoff + jitter.
export async function fetchJSON(url, { retries = 2, timeoutMs = 15000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": "sss-data/1.0 (+https://github.com/bemasiero/sss-data)" },
      })
      if (res.status === 400 || res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      if (attempt >= retries) throw err
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt + Math.random() * 300))
    }
  }
}

export async function fetchScoreboard(sport, slug, dateISO) {
  return fetchJSON(`${ESPN_SITE}/sports/${sport}/${slug}/scoreboard?dates=${yyyymmdd(dateISO)}`)
}

// Worker-style concurrency pool: runs fn over items with at most `limit` in flight.
export async function pool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i], i)
      }
    })
  )
  return results
}

// ─── ESPN payload helpers (ported from the CF Worker) ────────────────────────

// All competitions for an event; tennis nests matches under groupings[].
export function eventCompetitions(event) {
  const direct = event.competitions ?? []
  if (direct.length > 0) return direct
  return (event.groupings ?? []).flatMap(g => g.competitions ?? [])
}

// "in" if any competition is live, "post" if all finished, else "pre".
export function eventState(event) {
  const comps = eventCompetitions(event)
  if (comps.length === 0) return event.status?.type?.state ?? "pre"
  let allPost = true
  for (const c of comps) {
    const s = c.status?.type?.state
    if (s === "in") return "in"
    if (s !== "post") allPost = false
  }
  return allPost ? "post" : "pre"
}

// Earliest event/competition timestamp — multi-day tournaments report the
// event date as day 1, so take the minimum across all dates present.
export function eventStart(event) {
  const times = [event.date, ...eventCompetitions(event).map(c => c.date)]
    .filter(Boolean)
    .map(d => new Date(d).getTime())
    .filter(Number.isFinite)
  return times.length ? new Date(Math.min(...times)).toISOString() : null
}

export function extractName(data, fallback) {
  return data?.leagues?.[0]?.name ?? data?.leagues?.[0]?.abbreviation ?? fallback
}

// ─── Manifest assembly ────────────────────────────────────────────────────────

// Insert/replace events by id, keeping the array date-sorted.
// EPG enrichment (_broadcasts, added by epg.mjs at catalog time) is carried
// over so live polls don't strip it from refreshed events.
export function upsertEvents(payload, freshEvents) {
  const byId = new Map((payload.events ?? []).map(ev => [String(ev.id), ev]))
  for (const ev of freshEvents ?? []) {
    const old = byId.get(String(ev.id))
    if (old?._broadcasts && !ev._broadcasts) ev._broadcasts = old._broadcasts
    byId.set(String(ev.id), ev)
  }
  payload.events = [...byId.values()].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))
}

// Merge multiple scoreboard responses (one per date) for a league into the
// single payload shape the app expects: ESPN scoreboard + _meta.
export function mergeScoreboards(sport, slug, payloads) {
  const valid = payloads.filter(p => p && typeof p === "object")
  if (valid.length === 0) return null
  const base = structuredClone(valid[0])
  base.events = []
  for (const p of valid) upsertEvents(base, p.events)
  base._meta = { sport, slug, name: extractName(base, slug) }
  return base
}

// Compact per-event index used by the live poller for scheduling.
export function indexEvents(payload) {
  return (payload.events ?? []).map(ev => ({
    id: String(ev.id),
    start: eventStart(ev) ?? ev.date ?? null,
    state: eventState(ev),
  }))
}

export function sortLeagues(leagues) {
  return leagues.sort((a, b) =>
    `${a._meta?.sport}/${a._meta?.slug}`.localeCompare(`${b._meta?.sport}/${b._meta?.slug}`)
  )
}

// ─── IO ───────────────────────────────────────────────────────────────────────

export function readJSON(file, fallback = null) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback
}

export function writeJSON(file, obj, pretty = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj))
}

export function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
  console.log(`::output ${key}=${value}`)
}

// Minimal status page so the Pages site has an index.
export function writeSite(manifest) {
  writeJSON("site/manifest.json", manifest)
  const bytes = fs.statSync("site/manifest.json").size
  const events = manifest.leagues.reduce((n, l) => n + (l.events?.length ?? 0), 0)
  fs.writeFileSync(
    "site/index.html",
    `<!doctype html><meta charset="utf-8"><title>sss-data</title><pre>updatedAt: ${manifest.updatedAt}
leagues:   ${manifest.leagues.length}
events:    ${events}
size:      ${(bytes / 1048576).toFixed(1)} MB
→ <a href="manifest.json">manifest.json</a></pre>`
  )
  return { bytes, events }
}
