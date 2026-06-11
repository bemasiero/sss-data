// EPG broadcast enrichment — runs after catalog.mjs in the same workflow.
//
// Downloads open XMLTV guides (data/epg_sources.json), matches programmes
// against manifest events, and stamps `_broadcasts: [{country, channel}]`
// onto each matched event in site/manifest.json.
//
// Match rule (two independent filters must both pass):
//   1. Programme title contains an alias of BOTH teams. Aliases come from
//      ESPN names plus CLDR-localized country names for national teams
//      (e.g. "South Africa" → "África do Sul" for a pt-language guide).
//   2. Programme start within [kickoff − 45 min, kickoff + 30 min] — rejects
//      replays and post-match shows that repeat the match title.

import { readJSON, writeJSON, eventCompetitions, eventStart } from "./lib.mjs"
import zlib from "node:zlib"

const WINDOW_BEFORE = 45 * 60_000
const WINDOW_AFTER  = 30 * 60_000

// ─── Normalization & aliases ──────────────────────────────────────────────────

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" }
const decodeEntities = s => s.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, m => ENTITIES[m])

// lowercase, strip diacritics and punctuation — comparison space for titles/aliases
function norm(s) {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

// English country name → ISO region code, for national-team detection
const regionCodes = []
for (let a = 65; a <= 90; a++)
  for (let b = 65; b <= 90; b++)
    regionCodes.push(String.fromCharCode(a) + String.fromCharCode(b))

const enNames = new Intl.DisplayNames(["en"], { type: "region" })
const regionByEnglishName = new Map()
for (const code of regionCodes) {
  try {
    const name = enNames.of(code)
    if (name && name !== code) regionByEnglishName.set(norm(name), code)
  } catch {}
}
regionByEnglishName.set(norm("USA"), "US")
regionByEnglishName.set(norm("South Korea"), "KR")
regionByEnglishName.set(norm("North Korea"), "KP")
regionByEnglishName.set(norm("Ivory Coast"), "CI")

const localizedNames = new Map() // lang → Intl.DisplayNames
function aliasesFor(team, lang) {
  const out = new Set()
  for (const name of [team.displayName, team.shortDisplayName]) {
    if (name && name.length >= 4) out.add(norm(name))
  }
  // National team? Add the CLDR name in the guide's language.
  const code = regionByEnglishName.get(norm(team.displayName ?? ""))
  if (code) {
    if (!localizedNames.has(lang)) localizedNames.set(lang, new Intl.DisplayNames([lang], { type: "region" }))
    try {
      const local = localizedNames.get(lang).of(code)
      if (local && local.length >= 4) out.add(norm(local))
    } catch {}
  }
  return [...out].filter(a => a.length >= 4)
}

// ─── Build event matchers from the manifest ───────────────────────────────────

const manifest = readJSON("site/manifest.json")
if (!manifest) {
  console.error("site/manifest.json missing — run catalog.mjs first")
  process.exit(1)
}

const events = [] // { ref, kickoffMs, teams: [competitorA, competitorB] }
for (const league of manifest.leagues) {
  for (const ev of league.events ?? []) {
    const comps = eventCompetitions(ev)
    const competitors = comps[0]?.competitors ?? []
    if (competitors.length !== 2) continue // team-vs-team only; golf/racing skipped
    const start = eventStart(ev)
    if (!start) continue
    events.push({
      ref: ev,
      kickoffMs: new Date(start).getTime(),
      teams: competitors.map(c => c.team ?? {}),
    })
  }
}

// Hour-bucket index so each programme only tests nearby events
const buckets = new Map()
for (const e of events) {
  const h = Math.floor(e.kickoffMs / 3600_000)
  for (const b of [h - 1, h, h + 1]) {
    if (!buckets.has(b)) buckets.set(b, [])
    buckets.get(b).push(e)
  }
}
console.log(`matching ${events.length} team-vs-team events against EPG sources`)

// ─── XMLTV parsing (streaming, no DOM) ────────────────────────────────────────

function parseTimestamp(s) {
  // "20260612020000 +0000"
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/)
  if (!m) return null
  const off = m[7] ?? "+0000"
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off.slice(0, 3)}:${off.slice(3)}`)
}

const COUNTRY_PREFIX_ALIASES = { GB: ["GB", "UK"] }

function cleanChannelName(name, country) {
  let n = decodeEntities(name).trim()
  for (const p of COUNTRY_PREFIX_ALIASES[country] ?? [country]) {
    n = n.replace(new RegExp(`^${p}\\s*[-–|:]\\s*`, "i"), "") // "BR - SporTV" → "SporTV"
  }
  return n
}

async function processSource(src, results) {
  const res = await fetch(src.url, { redirect: "follow", signal: AbortSignal.timeout(300_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const gunzip = src.url.endsWith(".gz")
  const stream = gunzip ? res.body.pipeThrough(new DecompressionStream("gzip")) : res.body
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader()

  const channelNames = new Map()
  const aliasCache = new Map() // teamId|lang → aliases
  let buf = "", programmes = 0, matches = 0

  const handleBlock = block => {
    // <channel id="X"><display-name>Y</display-name>
    if (block.startsWith("<channel")) {
      const id = block.match(/id="([^"]*)"/)?.[1]
      const dn = block.match(/<display-name[^>]*>([^<]*)</)?.[1]
      if (id && dn) channelNames.set(id, cleanChannelName(dn, src.country))
      return
    }
    programmes++
    const startMs = parseTimestamp(block.match(/start="([^"]*)"/)?.[1] ?? "")
    if (!startMs) return
    const candidates = buckets.get(Math.floor(startMs / 3600_000))
    if (!candidates) return

    let titleNorm = null // lazily computed
    for (const e of candidates) {
      if (startMs < e.kickoffMs - WINDOW_BEFORE || startMs > e.kickoffMs + WINDOW_AFTER) continue
      if (titleNorm === null) {
        const titles = [...block.matchAll(/<title[^>]*>([^<]*)<\/title>/g)].map(m => decodeEntities(m[1]))
        titleNorm = " " + titles.map(norm).join(" | ") + " "
      }
      const hit = e.teams.every(team => {
        const ck = `${team.id ?? team.displayName}|${src.lang}`
        if (!aliasCache.has(ck)) aliasCache.set(ck, aliasesFor(team, src.lang))
        return aliasCache.get(ck).some(a => titleNorm.includes(` ${a} `) || titleNorm.includes(`${a} `) || titleNorm.includes(` ${a}`))
      })
      if (!hit) continue
      const channelId = block.match(/channel="([^"]*)"/)?.[1]
      const channel = channelNames.get(channelId) ?? channelId
      if (!channel) continue
      let list = results.get(e.ref)
      if (!list) { list = []; results.set(e.ref, list) }
      if (!list.some(b => b.country === src.country && b.channel === channel)) {
        list.push({ country: src.country, channel })
        matches++
      }
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (value) buf += value
    let idx
    while ((idx = buf.indexOf("</programme>")) !== -1) {
      const block = buf.slice(0, idx)
      const open = block.lastIndexOf("<programme")
      const chanStart = block.indexOf("<channel")
      // flush any channel definitions that precede this programme
      if (chanStart !== -1 && chanStart < open) {
        for (const cm of block.slice(0, open).matchAll(/<channel\s[\s\S]*?<\/channel>/g)) handleBlock(cm[0])
      }
      if (open !== -1) handleBlock(block.slice(open))
      buf = buf.slice(idx + 12)
    }
    if (done) break
    // safety: don't let buffer grow unbounded on malformed input
    if (buf.length > 50_000_000) buf = buf.slice(-10_000_000)
  }
  // trailing channels (files with channels after programmes are rare but cheap to cover)
  for (const cm of buf.matchAll(/<channel\s[\s\S]*?<\/channel>/g)) handleBlock(cm[0])

  return { programmes, matches }
}

// ─── Run all sources ──────────────────────────────────────────────────────────

const { sources } = readJSON("data/epg_sources.json")
const results = new Map() // event ref → [{country, channel}]

for (const src of sources) {
  const t0 = Date.now()
  try {
    const { programmes, matches } = await processSource(src, results)
    console.log(`${src.country}: ${programmes} programmes, ${matches} channel matches (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  } catch (err) {
    console.warn(`${src.country}: failed — ${err.message}`)
  }
}

let enriched = 0
for (const [ref, broadcasts] of results) {
  ref._broadcasts = broadcasts.sort((a, b) =>
    a.country === b.country ? a.channel.localeCompare(b.channel) : a.country.localeCompare(b.country))
  enriched++
}

writeJSON("site/manifest.json", manifest)
console.log(`enriched ${enriched}/${events.length} events with broadcasts`)
