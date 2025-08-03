const express = require("express");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your TheSportsDB key

// Whitelist of major leagues for TheSportsDB live filtering
const MAJOR = {
  soccer:            ["English Premier League", "La Liga", "UEFA Champions League"],
  basketball:        ["NBA"],
  american_football: ["NFL"],
  ice_hockey:        ["NHL"]
};

// Only attach TSDB header on v2 (live) calls
async function fetchJson(url, opts = {}) {
  try {
    const res = await fetch(url, opts);
    const txt = await res.text();
    if (txt.trim().startsWith("<!DOCTYPE") || txt.trim().startsWith("<html")) {
      console.error("HTML error from", url);
      return null;
    }
    return JSON.parse(txt);
  } catch (e) {
    console.error("Fetch error:", e);
    return null;
  }
}

// Map our sport codes to ESPN API paths
function getEspnPath(sport) {
  switch (sport) {
    case "soccer":            return "soccer/eng.1";
    case "basketball":        return "basketball/nba";
    case "american_football": return "football/nfl";
    case "ice_hockey":        return "hockey/nhl";
    default:                   return sport;
  }
}

// Normalize a TheSportsDB match object
function formatTSDB(m) {
  let status = (m.strStatus || "").toLowerCase().includes("live")
    ? "LIVE"
    : m.strStatus
      ? m.strStatus
      : (m.intHomeScore && m.intAwayScore)
        ? "Final"
        : m.dateEvent
          ? `on ${m.dateEvent}`
          : "Scheduled";

  return {
    team1:    m.strHomeTeam,
    score1:   m.intHomeScore  || "N/A",
    team2:    m.strAwayTeam,
    score2:   m.intAwayScore  || "N/A",
    league:   m.strLeague,
    headline: `${m.strHomeTeam} vs ${m.strAwayTeam} - ${status}`
  };
}

// Build up to 5 matches: live → upcoming/completed via ESPN
async function getMatches(sport) {
  const results = [];
  const majors = MAJOR[sport] || [];

  // 1️⃣ Live matches from TheSportsDB v2
  const tsdb = await fetchJson(
    `https://www.thesportsdb.com/api/v2/json/livescore/${sport}`,
    { headers: { "X-API-KEY": API_KEY } }
  );
  for (const m of tsdb?.livescore || []) {
    if (results.length >= 5) break;
    if (majors.includes(m.strLeague)) {
      results.push(formatTSDB(m));
    }
  }

  // 2️⃣ ESPN fallback for upcoming & completed
  if (results.length < 5) {
    const espn = await fetchJson(
      `https://site.api.espn.com/apis/site/v2/sports/${getEspnPath(sport)}/scoreboard`
    );
    for (const e of espn?.events || []) {
      if (results.length >= 5) break;
      const comp = e.competitions?.[0];
      if (!comp) continue;
      const home = comp.competitors.find(c => c.homeAway === "home");
      const away = comp.competitors.find(c => c.homeAway === "away");
      if (!home || !away) continue;

      // league name now correctly from e.league.name
      const leagueName = e.league?.name;
      if (!leagueName) continue;

      // Determine PRE/IN/POST state → Scheduled / LIVE / Final
      const state = e.status?.type?.state;
      const status =
        state === "IN"   ? "LIVE" :
        state === "POST" ? "Final" :
                           "Scheduled";

      results.push({
        team1:    home.team.displayName,
        score1:   home.score        || "N/A",
        team2:    away.team.displayName,
        score2:   away.score        || "N/A",
        league:   leagueName,
        headline: `${home.team.displayName} vs ${away.team.displayName} - ${status}`
      });
    }
  }

  return results;
}

// Four endpoints
app.get("/scores/soccer", async (req, res) => {
  const m = await getMatches("soccer");
  res.json(m.length
    ? m
    : [{ headline: "No major soccer games right now." }]
  );
});

app.get("/scores/nba", async (req, res) => {
  const m = await getMatches("basketball");
  res.json(m.length
    ? m
    : [{ headline: "No NBA games right now." }]
  );
});

app.get("/scores/nfl", async (req, res) => {
  const m = await getMatches("american_football");
  res.json(m.length
    ? m
    : [{ headline: "No NFL games right now." }]
  );
});

app.get("/scores/nhl", async (req, res) => {
  const m = await getMatches("ice_hockey");
  res.json(m.length
    ? m
    : [{ headline: "No NHL games right now." }]
  );
});

// Debug any URL
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

app.listen(PORT, () =>
  console.log(`Sports HQ running on http://localhost:${PORT}`)
);