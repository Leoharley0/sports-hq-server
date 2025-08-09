// server.js
const express = require("express");
const fetch   = require("node-fetch");

const app  = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TSDB_KEY || "342128"; // no < >

// ---------- helpers ----------
async function fetchJson(url) {
  try {
    const res = await fetch(url);
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

// NEVER fall back to strTime for status (that caused soccer to look LIVE)
function normalizeStatus(m) {
  const raw = m.strStatus || m.strProgress || ""; // no strTime here
  if (isLiveStatus(raw)) return "LIVE";
  if (raw === "NS" || raw === "" || raw === null) return "Scheduled";
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

// avoid dupes
function pushUnique(arr, m) {
  const key = m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent}|${m.strTime}`;
  if (!arr.some(x => (x.idEvent || `${x.strHomeTeam}|${x.strAwayTeam}|${x.dateEvent}|${x.strTime}`) === key)) {
    arr.push(m);
  }
}

// v2 livescore fetch that tries multiple spellings for NFL
async function fetchLiveForSport(sport) {
  const urls = [
    `https://www.thesportsdb.com/api/v2/json/${API_KEY}/livescore/${sport}`,
    `https://www.thesportsdb.com/api/v2/json/${API_KEY}/livescore.php?s=${sport}`,
  ];
  if (sport === "american_football") {
    urls.push(`https://www.thesportsdb.com/api/v2/json/${API_KEY}/livescore/american%20football`);
    urls.push(`https://www.thesportsdb.com/api/v2/json/${API_KEY}/livescore.php?s=american%20football`);
  }
  const out = [];
  for (const u of urls) {
    const j = await fetchJson(u);
    if (j?.livescore?.length) out.push(...j.livescore);
  }
  return out;
}

// live then upcoming (fill to 5)
async function getLeagueMatches(sport, leagueId) {
  const out = [];

  // 1) LIVE (strict league filter; skip rows without idLeague)
  const live = await fetchLiveForSport(sport);
  for (const m of live) {
    if (String(m.idLeague || "") === String(leagueId)) {
      pushUnique(out, m);
    }
  }

  // 2) UPCOMING (fill to 5) – v1 endpoint is fine here
  if (out.length < 5) {
    const up = await fetchJson(`https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventsnextleague.php?id=${leagueId}`);
    const events = Array.isArray(up?.events) ? up.events : [];
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

  return out.slice(0, 5);
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
      const matches = await getLeagueMatches(cfg.sport, cfg.leagueId);
      console.log(`${path} count=${matches.length}`,
        matches.map(m => `${m.strHomeTeam} v ${m.strAwayTeam} | raw=${m.strStatus || m.strProgress || ""}`));
      res.json(matches.map(formatMatch));
    } catch (e) {
      console.error(path, "handler error:", e);
      res.status(500).json({ error: "internal" });
    }
  });
}

app.get("/",  (_, res) => res.send("Sports HQ server ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));