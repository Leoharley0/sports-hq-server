// server.js
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

/* Render → Environment (no quotes):
   TSDB_V2_KEY = your v2 key   (required)
   TSDB_V1_KEY = 1             (or your v1 key; used only as fallback) */
const V2_KEY = process.env.TSDB_V2_KEY || process.env.TSDB_KEY || "";
const V1_KEY = process.env.TSDB_V1_KEY || "1";

/* Make TSDB/CDN happy */
const COMMON_HEADERS = {
  "User-Agent": "SportsHQ/1.0 (+render.com)",
  "Accept": "application/json",
  "Referer": "https://sports-hq-server.onrender.com/",
};

async function fetchJson(url, extraHeaders = {}) {
  const headers = { ...COMMON_HEADERS, ...extraHeaders };
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status} ${res.statusText} | ${body.slice(0,200)}`);
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
  return { team1: home, team2: away,
           score1: s1 === null ? "N/A" : String(s1),
           score2: s2 === null ? "N/A" : String(s2),
           headline: `${home} vs ${away} - ${status}` };
}
function pushUnique(arr, m) {
  const key = m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent}|${m.strTime}`;
  if (!arr.some(x => (x.idEvent || `${x.strHomeTeam}|${x.strAwayTeam}|${x.dateEvent}|${x.strTime}`) === key)) {
    arr.push(m);
  }
}

/* --- v2 helpers (header) --- */
async function v2Livescore(sport) {
  const s = sport.replace(/_/g, " ");
  const urls = [
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out = [];
  for (const u of urls) {
    const j = await fetchJson(u, { "X-API-KEY": V2_KEY });
    if (j?.livescore?.length) out.push(...j.livescore);
  }
  return out;
}
async function v2NextLeague(leagueId) {
  const j = await fetchJson(
    `https://www.thesportsdb.com/api/v2/json/eventsnextleague.php?id=${leagueId}`,
    { "X-API-KEY": V2_KEY }
  );
  return Array.isArray(j?.events) ? j.events : [];
}
async function v2Season(leagueId, season) {
  const j = await fetchJson(
    `https://www.thesportsdb.com/api/v2/json/eventsseason.php?id=${leagueId}&s=${encodeURIComponent(season)}`,
    { "X-API-KEY": V2_KEY }
  );
  return Array.isArray(j?.events) ? j.events : [];
}

/* --- v1 fallbacks (URL key) --- */
async function v1NextLeague(leagueId) {
  const j = await fetchJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsnextleague.php?id=${leagueId}`);
  return Array.isArray(j?.events) ? j.events : [];
}
async function v1Season(leagueId, season) {
  const j = await fetchJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsseason.php?id=${leagueId}&s=${encodeURIComponent(season)}`);
  return Array.isArray(j?.events) ? j.events : [];
}
async function v1PastLeague(leagueId) {
  const j = await fetchJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventspastleague.php?id=${leagueId}`);
  return Array.isArray(j?.events) ? j.events : [];
}

/* Guess current cross-year season like 2024-2025 */
function guessSeasonString() {
  const d = new Date(); const y = d.getUTCFullYear(); const m = d.getUTCMonth()+1;
  const start = (m >= 7) ? y : (y-1); return `${start}-${start+1}`;
}

/* LIVE → v2 next → v1 next → v2 season → v1 season → v1 past (fill to 5) */
async function getLeagueMatches(sport, leagueId) {
  const out = [];
  // LIVE
  const live = await v2Livescore(sport);
  for (const m of live) if (String(m.idLeague||"") === String(leagueId)) pushUnique(out, m);
  console.log(`[live] ${sport} league=${leagueId} -> ${out.length}`);

  // v2 next
  if (out.length < 5) {
    const e = await v2NextLeague(leagueId);
    e.sort((a,b)=>Date.parse(a.dateEvent)-Date.parse(b.dateEvent));
    for (const m of e) { if (out.length>=5) break; pushUnique(out,m); }
    console.log(`[next v2] ${sport} add=${out.length}`);
  }

  // v1 next
  if (out.length < 5) {
    const e = await v1NextLeague(leagueId);
    e.sort((a,b)=>Date.parse(a.dateEvent)-Date.parse(b.dateEvent));
    for (const m of e) { if (out.length>=5) break; pushUnique(out,m); }
    console.log(`[next v1] ${sport} add=${out.length}`);
  }

  // v2 season (future only)
  if (out.length < 5) {
    const season = guessSeasonString();
    const e = await v2Season(leagueId, season);
    const now = Date.now();
    const fut = e.filter(x=>{
      const t = Date.parse(`${x.dateEvent}T${(x.strTime||"00:00:00").replace(" ","")}Z`);
      return isFinite(t) && t>=now;
    }).sort((a,b)=>Date.parse(a.dateEvent)-Date.parse(b.dateEvent));
    for (const m of fut) { if (out.length>=5) break; pushUnique(out,m); }
    console.log(`[season v2] ${sport} add=${out.length}`);
  }

  // v1 season (future only)
  if (out.length < 5) {
    const season = guessSeasonString();
    const e = await v1Season(leagueId, season);
    const now = Date.now();
    const fut = e.filter(x=>{
      const t = Date.parse(`${x.dateEvent}T${(x.strTime||"00:00:00").replace(" ","")}Z`);
      return isFinite(t) && t>=now;
    }).sort((a,b)=>Date.parse(a.dateEvent)-Date.parse(b.dateEvent));
    for (const m of fut) { if (out.length>=5) break; pushUnique(out,m); }
    console.log(`[season v1] ${sport} add=${out.length}`);
  }

  // v1 past finals
  if (out.length < 5) {
    const e = await v1PastLeague(leagueId);
    e.sort((a,b)=>Date.parse(b.dateEvent)-Date.parse(a.dateEvent)); // newest first
    for (const m of e) {
      if (out.length>=5) break;
      m.strStatus = m.strStatus || "Final";
      pushUnique(out,m);
    }
    console.log(`[past v1] ${sport} add=${out.length}`);
  }

  return out.slice(0,5);
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
      console.log(`${path} -> ${raw.length} items`);
      res.json(raw.map(formatMatch));
    } catch (e) {
      console.error(path, "handler error:", e);
      res.status(500).json({ error: "internal" });
    }
  });
}

app.get("/", (_, res) => res.send("Sports HQ server ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));