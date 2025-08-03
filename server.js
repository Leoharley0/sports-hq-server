const express = require("express");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // Your TheSportsDB key

// Whitelist for live TSDB matches
const MAJOR = {
  soccer:            ["English Premier League", "La Liga", "UEFA Champions League"],
  basketball:        ["NBA"],
  american_football: ["NFL"],
  ice_hockey:        ["NHL"]
};

// Map sport → ESPN scoreboard path
function getEspnPath(sport) {
  switch (sport) {
    case "soccer":            return "soccer/eng.1";
    case "basketball":        return "basketball/nba";
    case "american_football": return "football/nfl";
    case "ice_hockey":        return "hockey/nhl";
    default:                  return sport;
  }
}

// Format dates as YYYYMMDD
function formatOffsetDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

// Smart JSON fetcher (TSDB v2 needs header)
async function fetchJson(url, opts = {}) {
  try {
    const response = await fetch(url, opts);
    const text = await response.text();
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

// Normalize a TSDB match
function formatTSDB(m) {
  let status;
  const st = (m.strStatus || "").toLowerCase();
  if (st.includes("live")) status = "LIVE";
  else if (st.includes("finished") || st.includes("ended") || st.includes("ft")) status = "Final";
  else if (m.dateEvent) status = `on ${m.dateEvent}`;
  else status = "Scheduled";

  return {
    team1:    m.strHomeTeam,
    score1:   m.intHomeScore || "N/A",
    team2:    m.strAwayTeam,
    score2:   m.intAwayScore || "N/A",
    league:   m.strLeague,
    headline: `${m.strHomeTeam} vs ${m.strAwayTeam} - ${status}`
  };
}

// Normalize an ESPN match
function formatESPN(e) {
  const comp = e.competitions?.[0];
  const home = comp?.competitors.find(c => c.homeAway === "home");
  const away = comp?.competitors.find(c => c.homeAway === "away");
  if (!home || !away) return null;

  const started   = e.status?.type?.started;
  const completed = e.status?.type?.completed;
  let status = "Scheduled";
  if (started && !completed) status = "LIVE";
  else if (completed)        status = "Final";

  return {
    team1:    home.team.displayName,
    score1:   home.score || "N/A",
    team2:    away.team.displayName,
    score2:   away.score || "N/A",
    league:   e.leagues?.[0]?.name || "",
    headline: `${home.team.displayName} vs ${away.team.displayName} - ${status}`
  };
}

// Core: get up to 5 matches per sport
async function getMatches(sport) {
  const results = [];
  const majors = MAJOR[sport] || [];

  // 1️⃣ TSDB live (v2)
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

  // 2️⃣ ESPN upcoming: next 3 days
  if (results.length < 5) {
    const espnPath = getEspnPath(sport);
    for (let d = 0; d < 3 && results.length < 5; d++) {
      const date = formatOffsetDate(d);
      const espn = await fetchJson(
        `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard?dates=${date}`
      );
      for (const e of espn?.events || []) {
        if (results.length >= 5) break;
        const fm = formatESPN(e);
        if (fm) results.push(fm);
      }
    }
  }

  // 3️⃣ ESPN completed: past 3 days
  if (results.length < 5) {
    const espnPath = getEspnPath(sport);
    for (let d = 1; d <= 3 && results.length < 5; d++) {
      const date = formatOffsetDate(-d);
      const espn = await fetchJson(
        `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard?dates=${date}`
      );
      for (const e of espn?.events || []) {
        if (results.length >= 5) break;
        const fm = formatESPN(e);
        if (fm) results.push(fm);
      }
    }
  }

  return results;
}

// Endpoints
app.get("/scores/soccer", async (req, res) => {
  const m = await getMatches("soccer");
  res.json(m.length
    ? m
    : [{ headline: "No major soccer games available." }]
  );
});

app.get("/scores/nba", async (req, res) => {
  const m = await getMatches("basketball");
  res.json(m.length
    ? m
    : [{ headline: "No NBA games available." }]
  );
});

app.get("/scores/nfl", async (req, res) => {
  const m = await getMatches("american_football");
  res.json(m.length
    ? m
    : [{ headline: "No NFL games available." }]
  );
});

app.get("/scores/nhl", async (req, res) => {
  const m = await getMatches("ice_hockey");
  res.json(m.length
    ? m
    : [{ headline: "No NHL games available." }]
  );
});

// Debug any URL
app.get("/scores/debug", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Provide ?url=");
  try {
    const txt = await (await fetch(url)).text();
    res.type("text/plain").send(txt);
  } catch (e) {
    res.send("Error: " + e);
  }
});

app.listen(PORT, () =>
  console.log(`Sports HQ running on http://localhost:${PORT}`)
);