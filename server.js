// server.js
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

/* Set these in Render → Environment (no quotes):
   TSDB_V2_KEY        = your TSDB v2 key (required for LIVE)
   FOOTBALL_DATA_KEY  = your football-data.org v4 key (required for EPL upcoming)
*/
const TSDB_KEY  = process.env.TSDB_V2_KEY || process.env.TSDB_KEY || "";
const FD_KEY    = process.env.FOOTBALL_DATA_KEY || "";

/* General headers so CDNs don’t 404 with HTML */
const COMMON_HEADERS = {
  "User-Agent": "SportsHQ/1.0 (+render.com)",
  "Accept": "application/json",
};

async function fetchJson(url, extraHeaders = {}) {
  try {
    const res = await fetch(url, { headers: { ...COMMON_HEADERS, ...extraHeaders } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status} ${res.statusText} | ${body.slice(0, 180)}`);
    }
    return await res.json();
  } catch (e) {
    console.error("fetchJson error:", e.message, "→", url);
    return null;
  }
}

/* ---------- helpers: formatting & status ---------- */
function finalize(team1, team2, score1, score2, status) {
  return { team1, team2, score1: String(score1 ?? "N/A"), score2: String(score2 ?? "N/A"),
           headline: `${team1} vs ${team2} - ${status}` };
}
function isLiveStatus(s = "") {
  const t = (s + "").toLowerCase();
  return t.includes("live") || t.includes("in play") || /^q\d/.test(t) ||
         t.includes("quarter") || t.includes("ot") || t.includes("overtime") || t.includes("half");
}
function isFinalStatus(s = "") {
  const t = (s + "").toLowerCase();
  return t.includes("final") || t === "ft" || t.includes("full time");
}
function normTSDBStatus(m) {
  const raw = m.strStatus || m.strProgress || "";
  if (isLiveStatus(raw)) return "LIVE";
  if (isFinalStatus(raw)) return "Final";
  return raw === "NS" || raw === "" ? "Scheduled" : raw;
}

/* ---------- LIVE: TheSportsDB v2 (header auth) ---------- */
async function tsdbLive(sport, leagueId) {
  const s = sport.replace(/_/g, " "); // "american_football" -> "american football"
  const urls = [
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const H = { "X-API-KEY": TSDB_KEY };
  const rows = [];
  for (const u of urls) {
    const j = await fetchJson(u, H);
    if (j?.livescore?.length) rows.push(...j.livescore);
  }
  const out = [];
  for (const m of rows) {
    if (String(m.idLeague || "") !== String(leagueId)) continue;
    out.push(finalize(
      m.strHomeTeam, m.strAwayTeam,
      m.intHomeScore ?? "N/A", m.intAwayScore ?? "N/A",
      "LIVE"
    ));
  }
  return out;
}

/* ---------- UPCOMING: EPL via football-data.org v4 ---------- */
function normalizeEPLName(n) {
  if (!n) return n;
  // remove common suffixes, unify & → and
  n = n.replace(/\s+FC$/i, "").replace(/&/g, "and");
  const map = {
    "AFC Bournemouth": "Bournemouth",
    "Brighton and Hove Albion": "Brighton and Hove Albion",
    "Wolverhampton Wanderers": "Wolverhampton Wanderers",
    "Tottenham Hotspur": "Tottenham Hotspur",
    "West Ham United": "West Ham United",
    "Newcastle United": "Newcastle United",
    "Manchester United": "Manchester United",
    "Manchester City": "Manchester City",
    "Nottingham Forest": "Nottingham Forest",
    "Sheffield United": "Sheffield United",
  };
  return map[n] || n; // most names already match your TEAM_LOGOS
}
async function eplUpcoming(limit = 5) {
  if (!FD_KEY) return []; // can’t query without a key
  const today = new Date();
  const to = new Date(today.getTime() + 14 * 86400000);
  const qs = `dateFrom=${today.toISOString().slice(0,10)}&dateTo=${to.toISOString().slice(0,10)}&status=SCHEDULED`;
  const j = await fetchJson(`https://api.football-data.org/v4/competitions/PL/matches?${qs}`, { "X-Auth-Token": FD_KEY });
  const arr = Array.isArray(j?.matches) ? j.matches : [];
  arr.sort((a,b)=> new Date(a.utcDate) - new Date(b.utcDate));
  const out = [];
  for (const m of arr) {
    if (out.length >= limit) break;
    const home = normalizeEPLName(m.homeTeam?.name);
    const away = normalizeEPLName(m.awayTeam?.name);
    out.push(finalize(home, away, "N/A", "N/A", "Scheduled"));
  }
  // Fallback to recent FINALS if nothing upcoming
  if (!out.length) {
    const pastQs = `dateFrom=${new Date(today.getTime()-21*86400000).toISOString().slice(0,10)}&dateTo=${today.toISOString().slice(0,10)}&status=FINISHED`;
    const p = await fetchJson(`https://api.football-data.org/v4/competitions/PL/matches?${pastQs}`, { "X-Auth-Token": FD_KEY });
    const pa = Array.isArray(p?.matches) ? p.matches : [];
    pa.sort((a,b)=> new Date(b.utcDate) - new Date(a.utcDate));
    for (const m of pa) {
      if (out.length >= limit) break;
      const home = normalizeEPLName(m.homeTeam?.name);
      const away = normalizeEPLName(m.awayTeam?.name);
      out.push(finalize(home, away, m.score?.fullTime?.home, m.score?.fullTime?.away, "Final"));
    }
  }
  return out.slice(0, limit);
}

/* ---------- UPCOMING: NBA via balldontlie.io ---------- */
function normalizeNBAName(n) {
  if (n === "LA Clippers") return "La Clippers"; // match your TEAM_LOGOS key
  return n;
}
async function nbaUpcoming(limit = 5) {
  const today = new Date();
  const to = new Date(today.getTime() + 21 * 86400000);
  const url = `https://www.balldontlie.io/api/v1/games?start_date=${today.toISOString().slice(0,10)}&end_date=${to.toISOString().slice(0,10)}&per_page=100`;
  const j = await fetchJson(url);
  const data = Array.isArray(j?.data) ? j.data : [];
  // take scheduled first
  const future = data.filter(g => (g.status || "").toLowerCase().includes("scheduled"));
  future.sort((a,b)=> new Date(a.date) - new Date(b.date));
  const out = [];
  for (const g of future) {
    if (out.length >= limit) break;
    const home = normalizeNBAName(g.home_team?.full_name);
    const away = normalizeNBAName(g.visitor_team?.full_name);
    out.push(finalize(home, away, "N/A", "N/A", "Scheduled"));
  }
  // fallback to recent finals
  if (out.length < limit) {
    const pastUrl = `https://www.balldontlie.io/api/v1/games?end_date=${today.toISOString().slice(0,10)}&start_date=${new Date(today.getTime()-30*86400000).toISOString().slice(0,10)}&per_page=100`;
    const pj = await fetchJson(pastUrl);
    const past = Array.isArray(pj?.data) ? pj.data : [];
    const finals = past.filter(g => (g.status || "").toLowerCase().includes("final"))
                       .sort((a,b)=> new Date(b.date) - new Date(a.date));
    for (const g of finals) {
      if (out.length >= limit) break;
      const home = normalizeNBAName(g.home_team?.full_name);
      const away = normalizeNBAName(g.visitor_team?.full_name);
      out.push(finalize(home, away, g.home_team_score, g.visitor_team_score, "Final"));
    }
  }
  return out.slice(0, limit);
}

/* ---------- UPCOMING: NHL via statsapi.web.nhl.com ---------- */
function mapNHLStatus(s = "") {
  const t = (s + "").toLowerCase();
  if (t.includes("preview") || t.includes("pre-game") || t.includes("scheduled")) return "Scheduled";
  if (t.includes("live") || t.includes("in progress")) return "LIVE";
  if (t.includes("final")) return "Final";
  return "Scheduled";
}
async function nhlUpcoming(limit = 5) {
  const today = new Date();
  const to = new Date(today.getTime() + 21 * 86400000);
  const url = `https://statsapi.web.nhl.com/api/v1/schedule?startDate=${today.toISOString().slice(0,10)}&endDate=${to.toISOString().slice(0,10)}`;
  const j = await fetchJson(url);
  const dates = Array.isArray(j?.dates) ? j.dates : [];
  const out = [];
  for (const d of dates) {
    for (const g of d.games || []) {
      if (out.length >= limit) break;
      const home = g.teams?.home?.team?.name;
      const away = g.teams?.away?.team?.name;
      const st   = mapNHLStatus(g.status?.abstractGameState || g.status?.detailedState);
      if (st === "Scheduled") {
        out.push(finalize(home, away, "N/A", "N/A", "Scheduled"));
      }
    }
    if (out.length >= limit) break;
  }
  // fallback to recent finals
  if (out.length < limit) {
    const pastUrl = `https://statsapi.web.nhl.com/api/v1/schedule?endDate=${today.toISOString().slice(0,10)}&startDate=${new Date(today.getTime()-21*86400000).toISOString().slice(0,10)}`;
    const p = await fetchJson(pastUrl);
    const pd = Array.isArray(p?.dates) ? p.dates : [];
    const finals = [];
    for (const d of pd) {
      for (const g of d.games || []) {
        const st = mapNHLStatus(g.status?.abstractGameState || g.status?.detailedState);
        if (st === "Final") {
          finals.push(finalize(
            g.teams?.home?.team?.name,
            g.teams?.away?.team?.name,
            g.teams?.home?.score,
            g.teams?.away?.score,
            "Final"
          ));
        }
      }
    }
    finals.sort(() => -1); // rough newest-first (API already groups by date)
    for (const row of finals) {
      if (out.length >= limit) break;
      out.push(row);
    }
  }
  return out.slice(0, limit);
}

/* ---------- combined endpoints ---------- */
async function getSoccer() {
  const out = [];
  // LIVE (EPL id = 4328)
  out.push(...await tsdbLive("soccer", 4328));
  if (out.length < 5) out.push(...await eplUpcoming(5 - out.length));
  return out.slice(0,5);
}
async function getNBA() {
  const out = [];
  // LIVE (NBA id = 4387)
  out.push(...await tsdbLive("basketball", 4387));
  if (out.length < 5) out.push(...await nbaUpcoming(5 - out.length));
  return out.slice(0,5);
}
async function getNFL() {
  // You already have NFL working via TSDB live; keep as-is + small fallback
  const out = await tsdbLive("american_football", 4391);
  return out.slice(0,5);
}
async function getNHL() {
  const out = [];
  // LIVE (NHL id = 4380)
  out.push(...await tsdbLive("ice_hockey", 4380));
  if (out.length < 5) out.push(...await nhlUpcoming(5 - out.length));
  return out.slice(0,5);
}

/* ---------- routes ---------- */
app.get("/scores/soccer",  async (_,res)=>{ try{ const d=await getSoccer();  res.json(d);} catch(e){ console.error(e); res.json([]);} });
app.get("/scores/nba",     async (_,res)=>{ try{ const d=await getNBA();     res.json(d);} catch(e){ console.error(e); res.json([]);} });
app.get("/scores/nfl",     async (_,res)=>{ try{ const d=await getNFL();     res.json(d);} catch(e){ console.error(e); res.json([]);} });
app.get("/scores/nhl",     async (_,res)=>{ try{ const d=await getNHL();     res.json(d);} catch(e){ console.error(e); res.json([]);} });

app.get("/",  (_,res)=>res.send("Sports HQ server ok"));
app.get("/health", (_,res)=>res.json({ok:true}));

app.listen(PORT, ()=>console.log(`Server listening on ${PORT}`));