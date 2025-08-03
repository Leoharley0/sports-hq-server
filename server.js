const express = require("express");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your TheSportsDB key

// Whitelist of big leagues per sport
const MAJOR = {
  soccer:           ["English Premier League", "La Liga", "UEFA Champions League"],
  basketball:       ["NBA"],
  american_football:["NFL"],
  ice_hockey:       ["NHL"]
};

// Helper: only send TSDB header on v2 calls
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

// Step-by-step collector
async function getMatches(sport, espnPath) {
  const results = [];
  const majors = MAJOR[sport] || [];

  // 1️⃣ Live from TheSportsDB
  const tsdb = await fetchJson(
    `https://www.thesportsdb.com/api/v2/json/livescore/${sport}`,
    { headers: { "X-API-KEY": API_KEY } }
  );
  for (const m of tsdb?.livescore || []) {
    if (results.length >= 5) break;
    if (majors.includes(m.strLeague)) {
      let status = (m.strStatus || "").toLowerCase().includes("live") ? "LIVE" : m.strStatus || "Scheduled";
      if (!m.strStatus && m.intHomeScore && m.intAwayScore) status = "Final";
      results.push({
        team1: m.strHomeTeam,
        score1: m.intHomeScore || "N/A",
        team2: m.strAwayTeam,
        score2: m.intAwayScore || "N/A",
        league: m.strLeague,
        headline: `${m.strHomeTeam} vs ${m.strAwayTeam} - ${status}`
      });
    }
  }

  // 2️⃣ Upcoming & Completed from ESPN
  if (results.length < 5) {
    const espn = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard`);
    for (const e of espn?.events || []) {
      if (results.length >= 5) break;
      const c = e.competitions?.[0];
      const home = c?.competitors.find(x => x.homeAway === "home");
      const away = c?.competitors.find(x => x.homeAway === "away");
      if (!home || !away) continue;
      // only major league events
      if (!majors.includes(c.league.name)) continue;

      let state = e.status.type.state;           // PRE / IN / POST
      let status = state === "IN"  ? "LIVE"
                 : state === "POST"? "Final"
                 :                    "Scheduled";

      results.push({
        team1: home.team.displayName,
        score1: home.score || "N/A",
        team2: away.team.displayName,
        score2: away.score || "N/A",
        league: c.league.name,
        headline: `${home.team.displayName} vs ${away.team.displayName} - ${status}`
      });
    }
  }

  return results;
}

// Endpoints
app.get("/scores/soccer", async (req, res) => {
  const m = await getMatches("soccer",           "soccer/eng.1");
  res.json(m.length ? m : [{ headline: "No major soccer games right now." }]);
});
app.get("/scores/nba", async (req, res) => {
  const m = await getMatches("basketball",       "basketball/nba");
  res.json(m.length ? m : [{ headline: "No NBA games right now." }]);
});
app.get("/scores/nfl", async (req, res) => {
  const m = await getMatches("american_football","football/nfl");
  res.json(m.length ? m : [{ headline: "No NFL games right now." }]);
});
app.get("/scores/nhl", async (req, res) => {
  const m = await getMatches("ice_hockey",       "hockey/nhl");
  res.json(m.length ? m : [{ headline: "No NHL games right now." }]);
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

app.listen(PORT, () => {
  console.log(`Sports HQ listening on port ${PORT}`);
});