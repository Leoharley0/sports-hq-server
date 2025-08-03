const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your premium key

// Helper: only send header for v2 (live) calls
async function fetchJson(url) {
  try {
    const opts = url.includes("/v2/") 
      ? { headers: { "X-API-KEY": API_KEY } } 
      : {};
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

// Format a match object
function formatMatch(m) {
  let status = "Scheduled";
  if (m.strStatus) {
    const s = m.strStatus.toLowerCase();
    if (s.includes("live"))      status = "LIVE";
    else if (s.includes("finished")||s.includes("ended")||s.includes("ft")) 
                                 status = "Final";
    else                          status = m.dateEvent ? `on ${m.dateEvent}` : "Scheduled";
  }
  return {
    team1:    m.strHomeTeam,
    score1:   m.intHomeScore  || "N/A",
    team2:    m.strAwayTeam,
    score2:   m.intAwayScore  || "N/A",
    league:   m.strLeague,
    headline: `${m.strHomeTeam} vs ${m.strAwayTeam} - ${status}`
  };
}

// Caches
const cache = {
  soccer: { ts: 0, data: [] },
  nba:    { ts: 0, data: [] },
  nfl:    { ts: 0, data: [] },
  nhl:    { ts: 0, data: [] },
};

// Soccer: live → upcoming (only 3 big leagues)
async function getSoccer() {
  const now = Date.now();
  if (now - cache.soccer.ts < 60000) return cache.soccer.data;

  // 1. Live
  let live = await fetchJson("https://www.thesportsdb.com/api/v2/json/livescore/soccer");
  live = (live?.livescore || [])
    .filter(m => ["English Premier League","La Liga","UEFA Champions League"].includes(m.strLeague))
    .slice(0,5)
    .map(formatMatch);

  if (live.length) {
    cache.soccer = { ts: now, data: live };
    return live;
  }

  // 2. Upcoming from EPL, La Liga, UCL
  const leagueIds = [4328,4335,4480];
  let up = [];
  for (let id of leagueIds) {
    let nxt = await fetchJson(
      `https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventsnextleague.php?id=${id}`
    );
    if (nxt?.events) up.push(...nxt.events);
  }
  // dedupe & sort by date
  const seen = new Set();
  up = up
    .filter(m => { if (seen.has(m.idEvent)) return false; seen.add(m.idEvent); return true; })
    .sort((a,b) => a.dateEvent.localeCompare(b.dateEvent))
    .slice(0,5)
    .map(formatMatch);

  cache.soccer = { ts: now, data: up };
  return up;
}

// Generic: sport code & leagueId
async function getSport(key, sport, leagueId) {
  const now = Date.now();
  if (now - cache[key].ts < 60000) return cache[key].data;

  // 1. Live
  let live = await fetchJson(`https://www.thesportsdb.com/api/v2/json/livescore/${sport}`);
  live = (live?.livescore || [])
    .map(formatMatch)
    .slice(0,5);

  if (live.length) {
    cache[key] = { ts: now, data: live };
    return live;
  }

  // 2. Upcoming
  let nxt = await fetchJson(
    `https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventsnextleague.php?id=${leagueId}`
  );
  let up = (nxt?.events || [])
    .sort((a,b) => a.dateEvent.localeCompare(b.dateEvent))
    .slice(0,5)
    .map(formatMatch);

  cache[key] = { ts: now, data: up };
  return up;
}

// Endpoints
app.get("/scores/soccer", async (req, res) => {
  const m = await getSoccer();
  res.json(m.length ? m : [{ headline: "No live or upcoming soccer games." }]);
});

app.get("/scores/nba", async (req, res) => {
  const m = await getSport("nba","basketball",4387);
  res.json(m.length ? m : [{ headline: "No live or upcoming basketball games." }]);
});

app.get("/scores/nfl", async (req, res) => {
  const m = await getSport("nfl","american_football",4391);
  res.json(m.length ? m : [{ headline: "No live or upcoming NFL games." }]);
});

app.get("/scores/nhl", async (req, res) => {
  const m = await getSport("nhl","hockey",4380);
  res.json(m.length ? m : [{ headline: "No live or upcoming hockey games." }]);
});

// Debug
app.get("/scores/debug", async (req, res) => {
  const url = req.query.url || "https://www.thesportsdb.com/api/v2/json/livescore/soccer";
  try {
    const r = await fetch(url, { headers: { "X-API-KEY": API_KEY } });
    const t = await r.text();
    res.type("text/plain").send(t);
  } catch (e) {
    res.send("Debug fetch error: " + e);
  }
});

app.listen(PORT, () => {
  console.log(`Sports HQ running on http://localhost:${PORT}`);
});