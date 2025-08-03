const express = require("express");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your TheSportsDB key

// Whitelist of big leagues for TSDB live
const MAJOR = {
  soccer:           ["English Premier League", "La Liga", "UEFA Champions League"],
  basketball:       ["NBA"],
  american_football:["NFL"],
  ice_hockey:       ["NHL"]
};

// Only TSDB v2 needs the header
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

// Build ESPN path per sport
function getEspnPath(sport) {
  switch (sport) {
    case "soccer":           return "soccer/eng.1";
    case "basketball":       return "basketball/nba";
    case "american_football":return "football/nfl";
    case "ice_hockey":       return "hockey/nhl";
  }
}

// Format a TSDB match
function formatTSDB(m) {
  let status = (m.strStatus||"").toLowerCase().includes("live")
    ? "LIVE"
    : m.strStatus
      ? m.strStatus
      : (m.intHomeScore && m.intAwayScore)
        ? "Final"
        : m.dateEvent
          ? `on ${m.dateEvent}`
          : "Scheduled";

  return {
    team1: m.strHomeTeam,
    score1:m.intHomeScore || "N/A",
    team2: m.strAwayTeam,
    score2:m.intAwayScore || "N/A",
    league: m.strLeague,
    headline: `${m.strHomeTeam} vs ${m.strAwayTeam} - ${status}`
  };
}

// Collect up to 5: live → upcoming & completed (ESPN)
async function getMatches(sport) {
  const results = [];
  const majors = MAJOR[sport] || [];

  // 1️⃣ Live from TSDB
  const tsdb = await fetchJson(
    `https://www.thesportsdb.com/api/v2/json/livescore/${sport}`,
    { headers: { "X-API-KEY": API_KEY } }
  );
  for (let m of tsdb?.livescore||[]) {
    if (results.length>=5) break;
    if (majors.includes(m.strLeague)) {
      results.push(formatTSDB(m));
    }
  }

  // 2️⃣ ESPN fallback (no extra whitelist)
  if (results.length<5) {
    const espn = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${getEspnPath(sport)}/scoreboard`);
    for (let e of espn?.events||[]) {
      if (results.length>=5) break;
      const c = e.competitions?.[0];
      if (!c) continue;
      const home = c.competitors.find(x=>x.homeAway==="home");
      const away = c.competitors.find(x=>x.homeAway==="away");
      if (!home||!away) continue;

      // Determine status
      const state = e.status?.type?.state; // PRE / IN / POST
      const status = state==="IN"   ? "LIVE"
                   : state==="POST"? "Final"
                   :                  "Scheduled";

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

// Four sport endpoints
app.get("/scores/soccer", async (req, res) => {
  const m = await getMatches("soccer");
  res.json(m.length ? m : [{ headline: "No major soccer games right now." }]);
});
app.get("/scores/nba", async (req, res) => {
  const m = await getMatches("basketball");
  res.json(m.length ? m : [{ headline: "No NBA games right now." }]);
});
app.get("/scores/nfl", async (req, res) => {
  const m = await getMatches("american_football");
  res.json(m.length ? m : [{ headline: "No NFL games right now." }]);
});
app.get("/scores/nhl", async (req, res) => {
  const m = await getMatches("ice_hockey");
  res.json(m.length ? m : [{ headline: "No NHL games right now." }]);
});

// Debug any URL
app.get("/scores/debug", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Provide ?url=");
  try {
    const t = await (await fetch(url)).text();
    res.type("text/plain").send(t);
  } catch (e) {
    res.send("Error: "+e);
  }
});

app.listen(PORT,() =>
  console.log(`Sports HQ running on http://localhost:${PORT}`)
);