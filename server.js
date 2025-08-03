const express = require("express");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your TheSportsDB v2 key

// 1. Whitelist of major leagues for live TSDB
const MAJOR = {
  soccer:            ["English Premier League", "La Liga", "UEFA Champions League"],
  basketball:        ["NBA"],
  american_football: ["NFL"],
  ice_hockey:        ["NHL"]
};

// 2. Map our sport codes to ESPN scoreboard paths
function getEspnPath(sport) {
  switch (sport) {
    case "soccer":            return "soccer/eng.1";
    case "basketball":        return "basketball/nba";
    case "american_football": return "football/nfl";
    case "ice_hockey":        return "hockey/nhl";
    default:                   return sport;
  }
}

// 3. Helper to format YYYYMMDD for ESPN dates
function formatDateOffset(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const YYYY = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const DD = String(d.getDate()).padStart(2, "0");
  return `${YYYY}${MM}${DD}`;
}

// 4. Smart fetch: only add TSDB header on v2 calls
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

// 5. Normalize a TSDB live match
function formatTSDB(m) {
  let status = "Scheduled";
  const s = (m.strStatus || "").toLowerCase();
  if (s.includes("live"))                   status = "LIVE";
  else if (/finished|ended|ft/.test(s))     status = "Final";
  else if (m.dateEvent)                     status = `on ${m.dateEvent}`;

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

// 6. Normalize an ESPN upcoming match
function formatESPN(e) {
  const comp = e.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors.find(c => c.homeAway === "home");
  const away = comp.competitors.find(c => c.homeAway === "away");
  if (!home || !away) return null;

  const state = e.status?.type?.state; // "PRE", "IN", "POST"
  const status = state === "IN"   ? "LIVE"
               : state === "POST" ? "Final"
               :                     "Scheduled";

  const leagueName = e.leagues?.[0]?.name || "";

  return {
    id:       e.id,
    team1:    home.team.displayName,
    score1:   home.score     || "N/A",
    team2:    away.team.displayName,
    score2:   away.score     || "N/A",
    league:   leagueName,
    headline: `${home.team.displayName} vs ${away.team.displayName} - ${status}`
  };
}

// 7. Core logic: live → upcoming-only, cap at 5
async function getMatches(sport) {
  const results = [];
  const seen    = new Set();
  const majors  = MAJOR[sport] || [];

  // 7.1 Live from TheSportsDB v2
  const tsdb = await fetchJson(
    `https://www.thesportsdb.com/api/v2/json/livescore/${sport}`,
    { headers: { "X-API-KEY": API_KEY } }
  );
  for (const m of tsdb?.livescore || []) {
    if (results.length >= 5) break;
    if (!majors.includes(m.strLeague)) continue;
    const fm = formatTSDB(m);
    results.push(fm);
    seen.add(fm.id);
  }

  // 7.2 ESPN upcoming (today + next 2 days)
  if (results.length < 5) {
    const path = getEspnPath(sport);
    for (let d = 0; d < 3 && results.length < 5; d++) {
      const date = formatDateOffset(d);
      const espn = await fetchJson(
        `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${date}`
      );
      for (const e of espn?.events || []) {
        if (results.length >= 5) break;
        if (seen.has(e.id)) continue;
        const fm = formatESPN(e);
        if (!fm) continue;
        results.push(fm);
        seen.add(e.id);
      }
    }
  }

  return results;
}

// 8. HTTP endpoints
app.get("/scores/soccer", async (req, res) => {
  const m = await getMatches("soccer");
  res.json(m.length
    ? m
    : [{ headline: "No major soccer games or upcoming slots available." }]
  );
});

app.get("/scores/nba", async (req, res) => {
  const m = await getMatches("basketball");
  res.json(m.length
    ? m
    : [{ headline: "No NBA games or upcoming slots available." }]
  );
});

app.get("/scores/nfl", async (req, res) => {
  const m = await getMatches("american_football");
  res.json(m.length
    ? m
    : [{ headline: "No NFL games or upcoming slots available." }]
  );
});

app.get("/scores/nhl", async (req, res) => {
  const m = await getMatches("ice_hockey");
  res.json(m.length
    ? m
    : [{ headline: "No NHL games or upcoming slots available." }]
  );
});

// 9. Debug route for any URL
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

// 10. Start server
app.listen(PORT, () => {
  console.log(`Sports HQ server running on port ${PORT}`);
});