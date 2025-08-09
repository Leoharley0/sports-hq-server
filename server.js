// server.js
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// Set these in Render → Environment (no quotes)
const V2_KEY = process.env.TSDB_V2_KEY || process.env.TSDB_KEY || "342128";
const V1_KEY = process.env.TSDB_V1_KEY || "1"; // v1 public key is fine for 'upcoming'

// ---------- helpers ----------
async function fetchJson(url, headers = {}) {
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
         t.includes("ot") || t.includes("overtime") ||
         t.includes("half");
}
function isFinalStatus(s = "") {
  const t = String(s).toLowerCase();
  return t.includes("final") || t === "ft" || t.includes("full time");
}
function pickScore(v) {
  return (v === undefined || v === null || v === "" || v === "N/A") ? null : v;
}

// DO NOT use strTime as status (caused false "LIVE")
function normalizeStatus(m) {
  const raw = m.strStatus || m.strProgress || "";   // no strTime
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

// v2 livescore with header; try both endpoints and handle NFL spacing
async function fetchLiveForSport(sport) {
  const s = sport.replace(/_/g, " "); // "american_football" -> "american football"
  const urls = [
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`,
  ];
  const headers = { "X-API-KEY": V2_KEY };

  const out = [];
  for (const u of urls) {
    const j = await fetchJson(u, headers);
    if (j?.livescore?.length) out.push(...j.livescore);
  }
  return out;
}

async function getLeagueMatches(sport, leagueId) {
  const out = [];

  // 1) LIVE (v2 with header; strict league filter)
  const live = await fetchLiveForSport(sport);
  for (const m of live || []) {
    if (String(m.idLeague || "") === String(leagueId)) {
      pushUnique(out, m);
    }
  }

  // 2) UPCOMING (v1) — fill to 5
  if (out.length < 5) {
    const up = await fetchJson(
      `https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsnextleague.php?id=${leagueId}`
    );
    const events = Array.isArray(up?.events) ? up.events : [];
    // sort by soonest
    events.sort((a, b) => {
      const da = new Date(`${a.dateEvent}T${(a.strTime || "00:00:00").replace(" ", "")}Z`);
      const db = new Date(`${b.dateEvent}T${(b.strTime || "00:00:00").replace(" ", "")}Z`);
      return da - db;
    });
    for (const m of events) {
      if (out.length >= 5) break;
      pushUnique(out, m);
    }
  }

  // 3) FALLBACK (v1 past) — if still <5, show most recent finals
  if (out.length < 5) {
    const past = await fetchJson(
      `https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventspastleague.php?id=${leagueId}`
    );
    let events = Array.isArray(past?.events) ? past.events : [];
    // latest first
    events.sort((a, b) => {
      const da = new Date(`${a.dateEvent}T${(a.strTime || "00:00:00").replace(" ", "")}Z`);
      const db = new Date(`${b.dateEvent}T${(b.strTime || "00:00:00").replace(" ", "")}Z`);
      return db - da;
    });
    for (const m of events) {
      if (out.length >= 5) break;
      // mark status Final so the client shows scores properly
      m.strStatus = m.strStatus || "Final";
      pushUnique(out, m);
    }
  }

  return out.slice(0, 5);
}
}

// endpoints
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