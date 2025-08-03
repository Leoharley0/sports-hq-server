const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your TheSportsDB premium key

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
    console.error("Fetch error", e);
    return null;
  }
}

// Whitelists
const MAJOR = {
  soccer: ["English Premier League", "La Liga", "UEFA Champions League"],
  basketball: ["NBA"],
  american_football: ["NFL"],
  ice_hockey: ["NHL"]
};

async function getMatches(sport, leagueId, espnLeagueSlug) {
  const results = [];

  // 1️⃣ TheSportsDB live (v2)
  let data = await fetchJson(`https://www.thesportsdb.com/api/v2/json/livescore/${sport}`, {
    headers: { "X-API-KEY": API_KEY }
  });
  if (data?.livescore) {
    for (const m of data.livescore) {
      if (results.length >= 5) break;
      if (MAJOR[sport].includes(m.strLeague)) {
        results.push({
          ...formatTSDB(m),
          source: "live"
        });
      }
    }
  }

  if (results.length < 5) {
    // 2️⃣ ESPN scoreboard for that league
    let espn = await fetchJson(
      `https://site.api.espn.com/apis/site/v2/sports/${getEspnSport(sport)}/${espnLeagueSlug}/scoreboard`
    );
    if (espn?.events) {
      for (const e of espn.events) {
        if (results.length >= 5) break;
        if (!results.find(r => r.id === e.id)) {
          results.push({
            id: e.id,
            team1: e.competitions[0].competitors[0].team.displayName,
            score1: e.competitions[0].competitors[0].score || "N/A",
            team2: e.competitions[0].competitors[1].team.displayName,
            score2: e.competitions[0].competitors[1].score || "N/A",
            league: espn.sport.displayName,
            headline: `${e.competitions[0].competitors[0].team.displayName} vs ${e.competitions[0].competitors[1].team.displayName} - ${e.status.type.state}`,
            source: e.status.type.state === "PRE" ? "upcoming" : "completed"
          });
        }
      }
    }
  }

  return results;
}

function formatTSDB(m) {
  return {
    id: m.idEvent,
    team1: m.strHomeTeam,
    score1: m.intHomeScore || "N/A",
    team2: m.strAwayTeam,
    score2: m.intAwayScore || "N/A",
    league: m.strLeague,
    headline: `${m.strHomeTeam} vs ${m.strAwayTeam} - ${m.strStatus}`,
  };
}

// Helper to map sports
function getEspnSport(sport) {
  switch (sport) {
    case "soccer": return "soccer/eng.1";
    case "basketball": return "basketball/nba";
    case "american_football": return "football/nfl";
    case "ice_hockey": return "hockey/nhl";
    default: return sport;
  }
}

app.get("/scores/:sport", async (req, res) => {
  const { sport } = req.params;
  const leagueId = { soccer: 4328, basketball: 4387, american_football: 4391, ice_hockey: 4380 }[sport];
  const espnSlug = { soccer: "eng.1", basketball: "nba", american_football: "nfl", ice_hockey: "nhl" }[sport];
  
  if (!leagueId) return res.json([{ headline: "Invalid sport" }]);
  
  let matches = await getMatches(sport, leagueId, espnSlug);
  if (matches.length === 0) {
    return res.json([{ headline: "No games available at the moment." }]);
  }
  res.json(matches);
});

app.listen(PORT, () => console.log(`Running on port ${PORT}`));