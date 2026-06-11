# sss-data

ESPN sports event data pipeline. Two GitHub Actions workflows fetch from the
public ESPN API and publish a manifest to GitHub Pages:

- **Catalog scan** (2×/day, 00:25 & 12:25 UTC): scans every league in
  `data/registry.json` for D-1/D/D+1 UTC and rebuilds the full manifest.
  Weekly league discovery runs on Sunday's early run (or dispatch with
  `discover: true`).
- **Live poll** (every 15 min): polls only leagues with a game live now or
  starting within 20 minutes, merges fresh scores into the published
  manifest, and skips the deploy entirely when nothing is on.

## Outputs

- `https://bemasiero.github.io/sss-data/manifest.json` — the app manifest:
  `{ updatedAt, leagues: [{ _meta: {sport, slug, name}, ...ESPN scoreboard }] }`
- `data/events.json` — compact schedule index (id/start/state per event),
  committed each run; this is the live poller's scheduling state.
- `data/registry.json` — league registry (seeded from `data/seed.json`,
  grown by discovery).

## Manual runs

Actions → "Catalog scan" / "Live poll" → Run workflow.
