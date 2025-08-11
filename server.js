// server.js — TSDB-only with "hide finals after 15 min" + /diag
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// Polyfill fetch for older Node
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// Render → Environment (no quotes):
//   TSDB_V2_KEY = your v2 key (required; header-based LIVE)
//   TSDB_V1_KEY = your v1 key (e.g. 123; URL-based)
const V2_KEY = process.env.TSDB_V2_KEY || "";
const V1_KEY = process.env.TSDB_V1_KEY || "";

// How long a finished game is allowed to remain visible
const FINAL_KEEP_MINUTES = 15;
const FINAL_KEEP_MS = FINAL_KEEP_MINUTES * 60 * 1000;

const COMMON_HEADERS = {
  "User-Agent": "SportsHQ/1.0 (+render.com)",
  "Accept": "application/json",
};

async function fetchJson(url, extraHeaders = {}) {
  try {
    const res = await fetch(url, { headers: { ...COMMON_HEADERS, ...extraHeaders } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status} ${res.statusText} | ${body.slice(0,180)}`);
    }
    return await res.json();
  } catch (e) {
    console.error("fetchJson error:", e.message, "→", url);
    return null;
  }
}

/* ---------------- helpers: status, time & formatting ---------------- */

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
function pickScore(v) {
  return (v === undefined || v === null || v === "" || v === "N/A") ? null : v;
}

// Try to get an event UTC timestamp for filtering finals
function eventMillis(m) {
  // Most v1 events have dateEvent + strTime (UTC or Z-suffixed)
  if (m.dateEvent) {
    const time = (m.strTime || "00:00:00").replace(" ", "");
    const ts = Date.parse(`${m.dateEvent}T${time}Z`);
    if (!Number.isNaN(ts)) return ts;
  }
  // Sometimes livescore includes strTimestamp (unix seconds) or strTimestampMS
  if (m.strTimestampMS) {
    const n = Number(m.strTimestampMS);
    if (!Number.isNaN(n)) return n;
  }
  if (m.strTimestamp) {
    const n = Number(m.strTimestamp) * 1000;
    if (!Number.isNaN(n)) return n;
  }
  return NaN; // unknown
}

// Only mark LIVE when status looks live **and** any score exists
function normalizeStatus(m, s1, s2) {
  const raw = String(m.strStatus || m.strProgress || "").trim();
  const hasScore = (s1 !== null) || (s2 !== null);

  if (isFinalWord(raw)) return "Final";
  if (isLiveWord(raw))  return hasScore ? "LIVE" : "Scheduled";
  if (!raw || raw === "NS" || raw.toLowerCase() === "scheduled" || raw.toLowerCase() === "preview")
    return "Scheduled";
  return hasScore ? raw : "Scheduled";
}

function formatMatch(m) {
  const home = m.strHomeTeam || m.homeTeam || m.strHome || "";
  const away = m.strAwayTeam || m.awayTeam || m.strAway || "";

  const s1raw = m.intHomeScore ?? m.intHomeScoreTotal ?? m.intHomeScore1 ?? m.intHomeGoals;
  const s2raw = m.intAwayScore ?? m.intAwayScoreTotal ?? m.intAwayScore1 ?? m.intAwayGoals;
  const s1 = pickScore(s1raw);
  const s2 = pickScore(s2raw);

  const status = normalizeStatus(m, s1, s2);

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
function guessSeasonString() {
  const d = new Date(); const y = d.getUTCFullYear(); const m = d.getUTCMonth()+1;
  const start = (m >= 7) ? y : (y - 1);
  return `${start}-${start+1}`;
}
app.get("/diag", async (_, res) => {
  const season = guessSeasonString();
  const v2h = { "X-API-KEY": V2_KEY };
  const checks = [];
  checks.push({ env: { node: process.version, hasV2Key: !!V2_KEY, v2KeyLen: (V2_KEY||"").length, hasV1Key: !!V1_KEY, v1Key: V1_KEY }});
  checks.push(await probe(`https://www.thesportsdb.com/api/v2/json/livescore/soccer`, v2h));
  for (const [_, id] of [["NBA",4387], ["NHL",4380], ["EPL",4328]]) {
    checks.push(await probe(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsnextleague.php?id=${id}`));
    checks.push(await probe(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsseason.php?id=${id}&s=${encodeURIComponent(season)}`));
    checks.push(await probe(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventspastleague.php?id=${id}`));
  }
  res.json({ ok:true, season, FINAL_KEEP_MINUTES, checks });
});

/* ---------------- TSDB fetchers ---------------- */

// v2 (header) livescore
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

// v1 (URL key) upcoming/past
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

/* ---------------- builder: LIVE → NEXT → SEASON → (recent) PAST ---------------- */

function isOldFinal(m) {
  const raw = m.strStatus || m.strProgress || "";
  if (!isFinalWord(raw)) return false;
  const t = eventMillis(m);
  if (Number.isNaN(t)) return false;               // can't tell => keep (better to show briefly)
  return (Date.now() - t) > FINAL_KEEP_MS;         // older than window => hide
}

async function getLeagueMatches(sport, leagueId) {
  const out = [];

  // 1) LIVE (filter out finals older than window just in case)
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
    e.sort((a,b) =>
      Date.parse(`${a.dateEvent}T${(a.strTime||"00:00:00").replace(" ","")}Z`) -
      Date.parse(`${b.dateEvent}T${(b.strTime||"00:00:00").replace(" ","")}Z`)
    );
    for (const m of e) { if (out.length >= 5) break; pushUnique(out, m); }
    console.log(`[next v1] ${sport} -> ${out.length}`);
  }

  // 3) SEASON (future only; catches preseason if present)
  if (out.length < 5) {
    const season = guessSeasonString();
    const e = await v1Season(leagueId, season);
    const now = Date.now();
    const fut = e.filter(x => {
      const t = Date.parse(`${x.dateEvent}T${(x.strTime||"00:00:00").replace(" ","")}Z`);
      return isFinite(t) && t >= now;
    }).sort((a,b) =>
      Date.parse(`${a.dateEvent}T${(a.strTime||"00:00:00").replace(" ","")}Z`) -
      Date.parse(`${b.dateEvent}T${(b.strTime||"00:00:00").replace(" ","")}Z`)
    );
    for (const m of fut) { if (out.length >= 5) break; pushUnique(out, m); }
    console.log(`[season v1 ${season}] ${sport} -> ${out.length}`);
  }

  // 4) PAST finals — but ONLY very recent (≤ FINAL_KEEP_MS)
  if (out.length < 5) {
    const e = await v1PastLeague(leagueId);
    e.sort((a,b) =>
      Date.parse(`${b.dateEvent}T${(b.strTime||"00:00:00").replace(" ","")}Z`) -
      Date.parse(`${a.dateEvent}T${(a.strTime||"00:00:00").replace(" ","")}Z`)
    );
    for (const m of e) {
      if (out.length >= 5) break;
      m.strStatus = m.strStatus || "Final";
      if (isOldFinal(m)) continue; // skip if older than window
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