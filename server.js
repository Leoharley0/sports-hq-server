// server.js
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

/*  Set these in Render → Environment (no quotes):
      TSDB_V2_KEY = your real v2 key  (used in X-API-KEY header for livescore)
      TSDB_V1_KEY = 1                 (or your v1 key; used for upcoming/past)
*/
const V2_KEY = process.env.TSDB_V2_KEY || process.env.TSDB_KEY || "";
const V1_KEY = process.env.TSDB_V1_KEY || "1";

/* Some TSDB/CDN edges 404 unless we send a normal UA/Accept */
const COMMON_HEADERS = {
  "User-Agent": "SportsHQ/1.0 (+render.com)",
  "Accept": "application/json",
};

async function fetchJson(url, extraHeaders = {}) {
  try {
    const res = await fetch(url, { headers: { ...COMMON_HEADERS, ...extraHeaders } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status} ${res.statusText} | ${body.slice(0, 200)}`);
    }
    return await res.json();
  } catch (e) {
    console.error("fetchJson error:", e.message, "→", url);
    return null;
  }
}

function isLiveStatus(s = "") {
  const t = String(s).toLowerCase();
  return t.includes("live") || t.includes("in play") ||
         /^q\d/.test(t) || t.includes("quarter") ||
         t.includes("ot") || t.includes("overtime") || t.includes("half");
}
function isFinalStatus(s = "") {
  const t = String(s).toLowerCase();
  return t.includes("final") || t === "ft" || t.includes("full time");
}
function pickScore(v) {
  return (v === undefined || v === null || v === "" || v === "N/A") ? null : v;
}

/* Never use strTime as status (causes false LIVE) */
function normalizeStatus(m) {
  const raw = m.strStatus || m.strProgress || "";
  if (isLiveStatus(raw)) return "LIVE";
  if (raw === "NS" || raw === "" || raw == null) return "Scheduled";
  if (isFinalStatus(raw)) return "Final";
  return raw;
}

function formatMatch(m) {
  const home = m.strHomeTeam || m.homeTeam || m.strHome || "";
  const away = m.strAwayTeam || m.awayTeam || m.strAway || "";

  const s1 = pickScore(m.intHomeScore ?? m.intHomeScoreTotal ?? m.intHomeScore1 ?? m.intHomeGoals);
  const s2 = pickScore(m.intAwayScore ?? m.intAwayScoreTotal ?? m.intAwayScore1 ?? m.intAwayGoals);

  const status = normalizeStatus(m);

  return {
    team1: home,
    team2: away,
    score1: s1 === null ? "N/A" : String(s1),
    score2: s2 === null ? "N/A" : String(s2),
    headline: `${home} vs ${away} - ${status}`,
  };
}

function pushUnique(arr, m) {
  const key = m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent}|${m.strTime}`;
  if (!arr.some(x => (x.idEvent || `${x.strHomeTeam}|${x.strAwayTeam}|${x.dateEvent}|${x.strTime}`) === key)) {
    arr.push(m);
  }
}

/* v2 livescore with header; try both routes; fix NFL spacing */
async function fetchLiveForSport(sport) {
  const s = sport.replace(/_/g, " "); // american_football -> american football
  const urls = [
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`,
  ];
  const out = [];
  for (const u of urls) {
    const j = await fetchJson(u, { "X-API-KEY": V2_KEY });
    if (j?.livescore?.length) out.push(...j.livescore);
  }
  return out;
}

/* Season string for v1 eventsseason fallback */
function guessSeasonString() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const startYear = (m >= 7) ? y : (y - 1);
  return `${startYear}-${startYear + 1}`;
}

/* LIVE → UPCOMING(next) → UPCOMING(season) → PAST (fill to 5) */
async function getLeagueMatches(sport, leagueId) {
  const out = [];

  // 1) LIVE (strict league filter)
  const live = await fetchLiveForSport(sport);
  for (const m of live || []) {
    if (String(m.idLeague || "") === String(leagueId)) pushUnique(out, m);
  }

  // 2) UPCOMING (v1 next-league)
  if (out.length < 5) {
    const up = await fetchJson(
      `https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsnextleague.php?id=${leagueId}`
    );
    const events = Array.isArray(up?.events) ? up.events : [];
    events.sort((a, b) => {
      const da = Date.parse(`${a.dateEvent}T${(a.strTime || "00:00:00").replace(" ", "")}Z`);
      const db = Date.parse(`${b.dateEvent}T${(b.strTime || "00:00:00").replace(" ", "")}Z`);
      return da - db;
    });
    for (const m of events) { if (out.length >= 5) break; pushUnique(out, m); }
  }

  // 3) UPCOMING fallback by season (v1 eventsseason)
  if (out.length < 5) {
    const season = guessSeasonString();
    const se = await fetchJson(
      `https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsseason.php?id=${leagueId}&s=${encodeURIComponent(season)}`
    );
    const all = Array.isArray(se?.events) ? se.events : [];
    const now = Date.now();
    const future = all.filter(e => {
      const t = Date.parse(`${e.dateEvent}T${(e.strTime || "00:00:00").replace(" ", "")}Z`);
      return isFinite(t) && t >= now;
    }).sort((a, b) => {
      const da = Date.parse(`${a.dateEvent}T${(a.strTime || "00:00:00").replace(" ", "")}Z`);
      const db = Date.parse(`${b.dateEvent}T${(b.strTime || "00:00:00").replace(" ", "")}Z`);
      return da - db;
    });
    for (const m of future) { if (out.length >= 5) break; pushUnique(out, m); }
  }

  // 4) PAST finals (v1) so screens never blank
  if (out.length < 5) {
    const past = await fetchJson(
      `https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventspastleague.php?id=${leagueId}`
    );
    const events = Array.isArray(past?.events) ? past.events : [];
    events.sort((a, b) => {
      const da = Date.parse(`${a.dateEvent}T${(a.strTime || "00:00:00").replace(" ", "")}Z`);
      const db = Date.parse(`${b.dateEvent}T${(b.strTime || "00:00:00").replace(" ", "")}Z`);
      return db - da; // newest first
    });
    for (const m of events) {
      if (out.length >= 5) break;
      m.strStatus = m.strStatus || "Final";
      pushUnique(out, m);
    }
  }

  return out.slice(0, 5);
}

/* endpoints */
const CONFIGS = {
  "/scores/soccer": { sport: "soccer",            leagueId: 4328 },
  "/scores/nba":    { sport: "basketball",        leagueId: 4387 },
  "/scores/nfl":    { sport: "american_football", leagueId: 4391 },
  "/scores/nhl":    { sport: "ice_hockey",        leagueId: 4380 },
};

for (const [path, cfg] of Object.entries(CONFIGS)) {
  app.get(path, async (req, res) => {
    try {
      const raw = await getLeagueMatches(cfg.sport, cfg.leagueId);
      console.log(`${path} count=${raw.length}`,
        raw.map(m => `${m.strHomeTeam} v ${m.strAwayTeam} | raw=${m.strStatus || m.strProgress || ""}`));
      res.json(raw.map(formatMatch));
    } catch (e) {
      console.error(path, "handler error:", e);
      res.status(500).json({ error: "internal" });
    }
  });
}

app.get("/",  (_, res) => res.send("Sports HQ server ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));