const express = require("express");
const fetch   = require("node-fetch");
const app     = express();
const PORT    = process.env.PORT || 3000;

const API_KEY = "342128"; // your TheSportsDB v2 key

// 1️⃣ Whitelist of major leagues for TSDB live filtering
const MAJOR = {
  soccer:            ["English Premier League", "La Liga", "UEFA Champions League"],
  basketball:        ["NBA"],
  american_football: ["NFL"],
  ice_hockey:        ["NHL"]
};

// 2️⃣ Default league names if ESPN omits them
const DEFAULT_LEAGUE = {
  soccer:            "Soccer",
  basketball:        "NBA",
  american_football: "NFL",
  ice_hockey:        "NHL"
};

// 3️⃣ Map sport codes to ESPN scoreboard paths
function getEspnPath(sport) {
  switch (sport) {
    case "soccer":            return "soccer/eng.1";
    case "basketball":        return "basketball/nba";
    case "american_football": return "football/nfl";
    case "ice_hockey":        return "hockey/nhl";
    default:                   return sport;
  }
}

// 4️⃣ Helper to format YYYYMMDD offsets
function dateOffset(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  return `${Y}${M}${D}`;
}

// 5️⃣ Smart JSON fetch (TSDB v2 needs header)
async function fetchJson(url, opts = {}) {
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    if (text.trim().startsWith("<!DOCTYPE") || text.trim().startsWith("<html")) {
      console.error("HTML error from", url);
      return null;
    }
    return JSON.parse(text);
  } catch (e) {
    console.error("Fetch error:", e);
    return null;
  }
}

// 6️⃣ Format a TSDB live match
function formatTSDB(m) {
  let status = "Scheduled";
  const s = (m.strStatus || "").toLowerCase();
  if (s.includes("live"))             status = "LIVE";
  else if (/finished|ended|ft/.test(s)) status = "Final";
  else if (m.dateEvent)               status = `on ${m.dateEvent}`;

  return {
    id:       m.idEvent,
    team1:    m.strHomeTeam,
    score1:   m.intHomeScore || "N/A",
    team2:    m.strAwayTeam,
    score2:   m.intAwayScore || "N/A",
    league:   m.strLeague,
    headline: `${m.strHomeTeam} vs ${m.strAwayTeam} - ${status}`
  };
}

// 7️⃣ Format an ESPN match (past, live, or upcoming)
function formatESPN(e, sport) {
  const comp = e.competitions?.[0];
  const home = comp?.competitors.find(c => c.homeAway === "home");
  const away = comp?.competitors.find(c => c.homeAway === "away");
  if (!home || !away) return null;

  const started   = e.status?.type?.started;
  const completed = e.status?.type?.completed;
  let status = "Scheduled";
  if (started && !completed) status = "LIVE";
  else if (completed)         status = "Final";

  const leagueName = e.leagues?.[0]?.name || DEFAULT_LEAGUE[sport];

  return {
    id:       e.id,
    team1:    home.team.displayName,
    score1:   home.score || "N/A",
    team2:    away.team.displayName,
    score2:   away.score || "N/A",
    league:   leagueName,
    headline: `${home.team.displayName} vs ${away.team.displayName} - ${status}`
  };
}

// 8️⃣ Core: pull up to 5 matches per sport
async function getMatches(sport) {
  const results = [];
  const seen    = new Set();
  const majors  = MAJOR[sport] || [];

  // a) TSDB live (v2)
  const liveData = await fetchJson(
    `https://www.thesportsdb.com/api/v2/json/livescore/${sport}`,
    { headers: { "X-API-KEY": API_KEY } }
  );
  for (const m of liveData?.livescore || []) {
    if (results.length >= 5) break;
    if (!majors.includes(m.strLeague)) continue;
    const fm = formatTSDB(m);
    results.push(fm);
    seen.add(fm.id);
  }

  // b) ESPN extended fallback (past, live, upcoming over 1 year)
  if (results.length < 5) {
    const path  = getEspnPath(sport);
    const start = dateOffset(0);
    const end   = dateOffset(365);
    const url   = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${start}-${end}`;

    const espnAll = await fetchJson(url);
    for (const e of espnAll?.events || []) {
      if (results.length >= 5) break;
      if (seen.has(e.id)) continue;
      const fm = formatESPN(e, sport);
      if (!fm) continue;
      results.push(fm);
      seen.add(e.id);
    }
  }

  return results;
}

// 9️⃣ HTTP endpoints
app.get("/scores/soccer", async (req, res) => {
  const m = await getMatches("soccer");
  res.json(m.length
    ? m
    : [{ headline: "No soccer games found." }]
  );
});

app.get("/scores/nba", async (req, res) => {
  const m = await getMatches("basketball");
  res.json(m.length
    ? m
    : [{ headline: "No NBA games found." }]
  );
});

app.get("/scores/nfl", async (req, res) => {
  const m = await getMatches("american_football");
  res.json(m.length
    ? m
    : [{ headline: "No NFL games found." }]
  );
});

app.get("/scores/nhl", async (req, res) => {
  const m = await getMatches("ice_hockey");
  res.json(m.length
    ? m
    : [{ headline: "No NHL games found." }]
  );
});

// 🔧 Debug any URL
app.get("/scores/debug", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Provide ?url=");
  try {
    const text = await (await fetch(url)).text();
    res.type("text/plain").send(text);
  } catch (e) {
    res.send("Error: " + e);
  }
});

// 🔥 Start server
app.listen(PORT, () => {
  console.log(`Sports HQ server running on port ${PORT}`);
});