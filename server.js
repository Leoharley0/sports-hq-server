// server.js — TSDB-only: LIVE (v2) + NEXT/SEASON/DAY/P AST (v1) + finals expire + /diag
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// Polyfill fetch for older Node
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// Env (set in Render → Environment, no quotes)
const V2_KEY = process.env.TSDB_V2_KEY || "";
const V1_KEY = process.env.TSDB_V1_KEY || "";
if (!V2_KEY) console.error("❌ Missing TSDB_V2_KEY (required for LIVE)");
if (!V1_KEY) console.warn("⚠️  TSDB_V1_KEY not set; v1 calls will fail");

// Friendly headers
const COMMON_HEADERS = { "User-Agent": "SportsHQ/1.0 (+render.com)", "Accept": "application/json" };

// Finals visibility window
const FINAL_KEEP_MINUTES = 15;
const FINAL_KEEP_MS = FINAL_KEEP_MINUTES * 60 * 1000;

/* ---------------- fetch helper ---------------- */
async function fetchJson(url, extraHeaders = {}) {
  try {
    const res = await fetch(url, { headers: { ...COMMON_HEADERS, ...extraHeaders } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status} ${res.statusText} | ${String(body).slice(0,180)}`);
    }
    return await res.json();
  } catch (e) {
    console.error("fetchJson error:", e.message, "→", url);
    return null;
  }
}

/* ---------------- time / status / format helpers ---------------- */
function toMillis(dateEvent, strTime) {
  if (!dateEvent) return NaN;
  const t = (strTime || "00:00:00").trim();
  const hasTZ = /[zZ]$|[+\-]\d\d:?\d\d$/.test(t);  // already Z or +hh:mm
  const iso = `${dateEvent}T${t}${hasTZ ? "" : "Z"}`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? NaN : ms;
}
function eventMillis(m) {
  if (m.dateEvent) {
    const ms = toMillis(m.dateEvent, m.strTime);
    if (!Number.isNaN(ms)) return ms;
  }
  if (m.strTimestampMS) { const n = Number(m.strTimestampMS); if (!Number.isNaN(n)) return n; }
  if (m.strTimestamp)   { const n = Number(m.strTimestamp)*1000; if (!Number.isNaN(n)) return n; }
  return NaN;
}
function isLiveWord(s = "") {
  const t = (s + "").toLowerCase();
  return t.includes("live") || t.includes("in play") ||
         /^q\d/.test(t) || t.includes("quarter") ||
         t.includes("ot") || t.includes("overtime") ||
         t.includes("half") || t === "ht";
}
function isFinalWord(s = "") {
  const t = (s + "").toLowerCase();
  return t.includes("final") || t === "ft" || t.includes("full time");
}
function pickScore(v) { return (v === undefined || v === null || v === "" || v === "N/A") ? null : v; }
// Only mark LIVE when looks live **and** any score exists
function normalizeStatus(m, s1, s2) {
  const raw = String(m.strStatus || m.strProgress || "").trim();
  const hasScore = (s1 !== null) || (s2 !== null);
  if (isFinalWord(raw)) return "Final";
  if (isLiveWord(raw))  return hasScore ? "LIVE" : "Scheduled";
  if (!raw || raw === "NS" || raw.toLowerCase() === "scheduled" || raw.toLowerCase() === "preview") return "Scheduled";
  return hasScore ? raw : "Scheduled";
}
function formatMatch(m) {
  const home = m.strHomeTeam || m.homeTeam || m.strHome || "";
  const away = m.strAwayTeam || m.awayTeam || m.strAway || "";
  const s1 = pickScore(m.intHomeScore ?? m.intHomeScoreTotal ?? m.intHomeScore1 ?? m.intHomeGoals);
  const s2 = pickScore(m.intAwayScore ?? m.intAwayScoreTotal ?? m.intAwayScore1 ?? m.intAwayGoals);
  const status = normalizeStatus(m, s1, s2);
  return { team1: home, team2: away, score1: s1 === null ? "N/A" : String(s1), score2: s2 === null ? "N/A" : String(s2), headline: `${home} vs ${away} - ${status}` };
}
function pushUnique(arr, m) {
  const key = m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent}|${m.strTime}`;
  if (!arr.some(x => (x.idEvent || `${x.strHomeTeam}|${x.strAwayTeam}|${x.dateEvent}|${x.strTime}`) === key)) arr.push(m);
}
function isOldFinal(m) {
  const raw = m.strStatus || m.strProgress || "";
  if (!isFinalWord(raw)) return false;
  const t = eventMillis(m);
  if (Number.isNaN(t)) return false;              // unknown -> keep briefly
  return (Date.now() - t) > FINAL_KEEP_MS;
}

/* ---------------- diagnostics ---------------- */
async function probe(url, extraHeaders = {}) {
  try {
    const res = await fetch(url, { headers: { ...COMMON_HEADERS, ...extraHeaders } });
    const text = await res.text();
    return { ok: res.ok, status: res.status, url, preview: text.slice(0,160) };
  } catch (e) {
    return { ok: false, status: 0, url, error: String(e) };
  }
}
function guessSeasonCrossYear() {
  const d = new Date(); const y = d.getUTCFullYear(); const m = d.getUTCMonth()+1;
  const start = (m >= 7) ? y : (y - 1);
  return `${start}-${start+1}`;
}
app.get("/diag", async (_, res) => {
  const season = guessSeasonCrossYear();
  const v2h = { "X-API-KEY": V2_KEY };
  const checks = [];
  checks.push({ env: { node: process.version, hasV2Key: !!V2_KEY, v2KeyLen: (V2_KEY||"").length, hasV1Key: !!V1_KEY, v1Key: V1_KEY }});
  checks.push(await probe(`https://www.thesportsdb.com/api/v2/json/livescore/soccer`, v2h));
  for (const [_, id] of [["NBA",4387], ["NHL",4380], ["EPL",4328], ["NFL",4391]]) {
    checks.push(await probe(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsnextleague.php?id=${id}`));
    checks.push(await probe(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsseason.php?id=${id}&s=${encodeURIComponent(season)}`));
    // today eventsday by sport (see below) for visibility
    checks.push(await probe(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsday.php?d=${new Date().toISOString().slice(0,10)}&s=American%20Football`));
  }
  res.json({ ok:true, seasonCross: season, FINAL_KEEP_MINUTES, checks });
});

/* ---------------- TSDB fetchers ---------------- */
// v2 LIVE
async function v2Livescore(sport) {
  const s = sport.replace(/_/g, " ");
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
// v1 NEXT/SEASON/PAST
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

/* ---------------- NEW: v1 eventsday (by sport) upcoming ---------------- */
const SPORT_LABEL = {
  soccer: "Soccer",
  basketball: "Basketball",
  american_football: "American Football",
  ice_hockey: "Ice Hockey",
};

async function v1UpcomingByDays(sport, leagueId, daysAhead = 21, limit = 10) {
  const label = SPORT_LABEL[sport] || sport;
  const out = [];
  const today = new Date();
  for (let d = 0; d < daysAhead && out.length < limit; d++) {
    const dt = new Date(today.getTime() + d * 86400000);
    const ymd = dt.toISOString().slice(0, 10);
    const j = await fetchJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`);
    const rows = Array.isArray(j?.events) ? j.events : [];
    for (const m of rows) {
      if (out.length >= limit) break;
      if (String(m.idLeague || "") !== String(leagueId)) continue;
      // future only (or same day later)
      const ms = toMillis(m.dateEvent, m.strTime);
      if (isFinite(ms) && ms < Date.now()) continue;
      pushUnique(out, m);
    }
  }
  // sort ascending just in case multiple days mixed
  out.sort((a,b) => toMillis(a.dateEvent, a.strTime) - toMillis(b.dateEvent, b.strTime));
  return out.slice(0, limit);
}

/* ---------------- season format candidates by league ---------------- */
function seasonCandidates(sport, leagueId) {
  const d = new Date();
  const y = d.getUTCFullYear();
  const cross = guessSeasonCrossYear();       // "2025-2026"
  const crossPrev = `${y-1}-${y}`;
  const single = String(y);
  const singlePrev = String(y - 1);

  if (leagueId === 4391 || sport === "american_football") { // NFL
    return [single, singlePrev, cross, crossPrev];
  }
  if (leagueId === 4387 || leagueId === 4380) { // NBA / NHL
    return [cross, crossPrev, single, singlePrev];
  }
  if (leagueId === 4328) { // EPL
    return [cross, crossPrev];
  }
  return [cross, single, crossPrev, singlePrev];
}

/* ---------------- builder: LIVE → NEXT → SEASON → DAY → PAST ---------------- */
async function getLeagueMatches(sport, leagueId) {
  const out = [];

  // 1) LIVE
  const live = await v2Livescore(sport);
  for (const m of live || []) {
    if (String(m.idLeague || "") !== String(leagueId)) continue;
    if (isOldFinal(m)) continue;
    pushUnique(out, m);
  }
  console.log(`[live] ${sport} league=${leagueId} -> ${out.length}`);

  // 2) NEXT (upcoming)
  if (out.length < 5) {
    const e = await v1NextLeague(leagueId);
    e.sort((a,b) => toMillis(a.dateEvent, a.strTime) - toMillis(b.dateEvent, b.strTime));
    for (const m of e) { if (out.length >= 5) break; pushUnique(out, m); }
    console.log(`[next v1] ${sport} -> ${out.length}`);
  }

  // 3) SEASON (future only; try multiple season formats)
  if (out.length < 5) {
    const tried = [];
    for (const s of seasonCandidates(sport, leagueId)) {
      tried.push(s);
      const e = await v1Season(leagueId, s);
      const now = Date.now();
      const fut = e.filter(x => {
        const t = toMillis(x.dateEvent, x.strTime);
        return isFinite(t) && t >= now;
      }).sort((a,b) => toMillis(a.dateEvent, a.strTime) - toMillis(b.dateEvent, b.strTime));
      for (const m of fut) { if (out.length >= 5) break; pushUnique(out, m); }
      console.log(`[season v1 tried=${tried.join(",")}] ${sport} -> ${out.length}`);
      if (out.length >= 5) break;
    }
  }

  // 4) DAY (by sport) — scan next ~3 weeks to fill Scheduled games
  if (out.length < 5) {
    const add = await v1UpcomingByDays(sport, leagueId, 21, 10);
    for (const m of add) { if (out.length >= 5) break; pushUnique(out, m); }
    console.log(`[day v1 scan] ${sport} -> ${out.length}`);
  }

  // 5) PAST (only very recent finals ≤ 15m) — last resort
  if (out.length < 5) {
    const e = await v1PastLeague(leagueId);
    e.sort((a,b) => toMillis(b.dateEvent, b.strTime) - toMillis(a.dateEvent, a.strTime));
    for (const m of e) {
      if (out.length >= 5) break;
      m.strStatus = m.strStatus || "Final";
      if (isOldFinal(m)) continue;
      pushUnique(out, m);
    }
    console.log(`[past v1 recent≤${FINAL_KEEP_MINUTES}m] ${sport} -> ${out.length}`);
  }

  return out.slice(0, 5);
}

/* ---------------- endpoints ---------------- */
const CONFIGS = {
  "/scores/soccer": { sport: "soccer",            leagueId: 4328 },
  "/scores/nba":    { sport: "basketball",        leagueId: 4387 },
  "/scores/nfl":    { sport: "american_football", leagueId: 4391 },
  "/scores/nhl":    { sport: "ice_hockey",        leagueId: 4380 },
};

for (const [path, cfg] of Object.entries(CONFIGS)) {
  app.get(path, async (req, res) => {
    try {
      const items = await getLeagueMatches(cfg.sport, cfg.leagueId);
      console.log(`${path} → ${items.length} items`);
      res.json(items.map(formatMatch));
    } catch (e) {
      console.error(path, "handler error:", e);
      res.status(500).json({ error: "internal" });
    }
  });
}

app.get("/",  (_, res) => res.send("Sports HQ server ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));