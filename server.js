// server.js — Real scores for Roblox Sports HQ
const express   = require("express");
const fetch     = require("node-fetch");
const app       = express();
const PORT      = process.env.PORT || 3000;

// Your premium TheSportsDB API key
const API_KEY = "342128";

// Helper: fetch & parse JSON (with API key in header)
async function fetchJson(url) {
  try {
    const res  = await fetch(url, { headers: { "X-API-KEY": API_KEY } });
    const txt  = await res.text();
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

//  ─── Build & sort a combined list of matches ─────────────────────
async function getLeagueMatches(sport, leagueId) {
  const all = [];

  // 1) Live (v2)
  if (sport) {
    const v2 = await fetchJson(`https://www.thesportsdb.com/api/v2/json/${API_KEY}/livescore/${sport}`);
    if (v2?.livescore) v2.livescore.forEach(m => all.push(m));
  }

  // 2) Upcoming (v1)
  const up = await fetchJson(`https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventsnextleague.php?id=${leagueId}`);
  if (up?.events) up.events.forEach(m => all.push(m));

  // 3) Past (v1)
  const past = await fetchJson(`https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventspastleague.php?id=${leagueId}`);
  if (past?.events) past.events.forEach(m => all.push(m));

  // Sort: live first, then soonest upcoming, then most recent past
  all.sort((a, b) => {
    const aLive = a.strStatus?.toLowerCase().includes("live");
    const bLive = b.strStatus?.toLowerCase().includes("live");
    if (aLive !== bLive) return aLive ? -1 : 1;

    // both upcoming?
    if (a.dateEvent && b.dateEvent) {
      const diff = new Date(a.dateEvent) - new Date(b.dateEvent);
      if (diff !== 0) return diff;
    }
    if (a.dateEvent) return -1; // upcoming before past
    if (b.dateEvent) return  1;

    // both past: most recent first
    const at = a.dateEvent  ? new Date(a.dateEvent).getTime()  : 0;
    const bt = b.dateEvent  ? new Date(b.dateEvent).getTime()  : 0;
    return bt - at;
  });

  // Return up to five
  return all.slice(0, 5);
}

// Map TheSportsDB event object to your JSON shape
function formatMatch(m) {
  return {
    team1:    m.strHomeTeam,
    score1:   m.intHomeScore  ?? "N/A",
    team2:    m.strAwayTeam,
    score2:   m.intAwayScore  ?? "N/A",
    headline: `${m.strHomeTeam} vs ${m.strAwayTeam} - ${m.strStatus || "Scheduled"}`
  };
}

// ─── HTTP Endpoints ────────────────────────────────────────────────

// Soccer (EPL)
app.get("/scores/soccer", async (req, res) => {
  const matches = await getLeagueMatches("soccer", 4328);
  res.json(matches.map(formatMatch));
});

// NBA
app.get("/scores/nba", async (req, res) => {
  const matches = await getLeagueMatches("basketball", 4387);
  res.json(matches.map(formatMatch));
});

// NFL
app.get("/scores/nfl", async (req, res) => {
  const matches = await getLeagueMatches("american_football", 4391);
  res.json(matches.map(formatMatch));
});

// NHL — note: v2 endpoint expects "ice_hockey", not "hockey"
app.get("/scores/nhl", async (req, res) => {
  const matches = await getLeagueMatches("ice_hockey", 4380);
  res.json(matches.map(formatMatch));
});

// (Optional) Raw debug endpoint
app.get("/scores/debug", async (req, res) => {
  const url = req.query.url || `https://www.thesportsdb.com/api/v2/json/${API_KEY}/livescore/soccer`;
  try {
    const resp = await fetch(url, { headers: { "X-API-KEY": API_KEY } });
    const text = await resp.text();
    res.setHeader("Content-Type", "text/plain");
    res.send(text);
  } catch (err) {
    res.status(500).send("Debug fetch error: " + err);
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Sports HQ server running on http://localhost:${PORT}`);
});