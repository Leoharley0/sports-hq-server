// server.js

const express   = require("express");
const fetch     = require("node-fetch");
const app       = express();
const PORT      = process.env.PORT || 3000;
const API_KEY   = "342128"; // your key

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: { "X-API-KEY": API_KEY } });
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 1) Get up to 5 live games via v2
 * 2) If <5, fetch upcoming (v1) and fill to 5
 */
async function getLeagueMatches(sport, leagueId) {
  const result = [];

  // 1) live games
  if (sport) {
    const liveData = await fetchJson(
      `https://www.thesportsdb.com/api/v2/json/${API_KEY}/livescore/${sport}`
    );
    if (liveData?.livescore?.length) {
      result.push(...liveData.livescore);
    }
  }

  // 2) fill with upcoming until we have 5
  if (result.length < 5) {
    const up = await fetchJson(
      `https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventsnextleague.php?id=${leagueId}`
    );
    if (up?.events?.length) {
      // sort upcoming by soonest date
      up.events.sort((a, b) => new Date(a.dateEvent) - new Date(b.dateEvent));
      const need = 5 - result.length;
      result.push(...up.events.slice(0, need));
    }
  }

  // 3) cap at 5
  return result.slice(0, 5);
}

// helper to shape your JSON
function formatMatch(m) {
  return {
    team1:    m.strHomeTeam,
    score1:   m.intHomeScore  ?? "N/A",
    team2:    m.strAwayTeam,
    score2:   m.intAwayScore  ?? "N/A",
    headline: `${m.strHomeTeam} vs ${m.strAwayTeam} - ${m.strStatus || "Scheduled"}`
  };
}

// endpoints
app.get("/scores/soccer", async (req, res) => {
  const matches = await getLeagueMatches("soccer", 4328);
  res.json(matches.map(formatMatch));
});

app.get("/scores/nba", async (req, res) => {
  const matches = await getLeagueMatches("basketball", 4387);
  res.json(matches.map(formatMatch));
});

app.get("/scores/nfl", async (req, res) => {
  const matches = await getLeagueMatches("american_football", 4391);
  res.json(matches.map(formatMatch));
});

app.get("/scores/nhl", async (req, res) => {
  const matches = await getLeagueMatches("ice_hockey", 4380);
  res.json(matches.map(formatMatch));
});

app.listen(PORT, () => {
  console.log(`Sports HQ server running on http://localhost:${PORT}`);
});