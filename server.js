const express = require("express");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your TheSportsDB key

// 1. Major‐league whitelist for TheSportsDB live
const MAJOR = {
  soccer:            ["English Premier League","La Liga","UEFA Champions League"],
  basketball:        ["NBA"],
  american_football: ["NFL"],
  ice_hockey:        ["NHL"]
};

// 2. Fallback default league names for ESPN
const DEFAULT_LEAGUE = {
  soccer:            "Soccer",
  basketball:        "NBA",
  american_football: "NFL",
  ice_hockey:        "NHL"
};

// 3. Map sport → ESPN path
function getEspnPath(sport) {
  switch (sport) {
    case "soccer":            return "soccer/eng.1";
    case "basketball":        return "basketball/nba";
    case "american_football": return "football/nfl";
    case "ice_hockey":        return "hockey/nhl";
  }
}

// 4. Smart JSON fetch
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

// 5. Format TSDB match
function formatTSDB(m) {
  let status = "Scheduled";
  const s = (m.strStatus||"").toLowerCase();
  if (s.includes("live")) status = "LIVE";
  else if (/finished|ended|ft/.test(s)) status = "Final";
  else if (m.dateEvent) status = `on ${m.dateEvent}`;

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

// 6. Format ESPN match
function formatESPN(e, sport) {
  const comp = e.competitions?.[0];
  const home = comp?.competitors.find(c=>c.homeAway==="home");
  const away = comp?.competitors.find(c=>c.homeAway==="away");
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

// 7. YYYYMMDD helper
function formatDateOffset(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const Y = d.getFullYear();
  const M = String(d.getMonth()+1).padStart(2,"0");
  const D = String(d.getDate()).padStart(2,"0");
  return `${Y}${M}${D}`;
}

// 8. Core getMatches
async function getMatches(sport) {
  const results = [];
  const seen    = new Set();
  const majors  = MAJOR[sport] || [];

  // 1️⃣ TSDB live
  const tsdb = await fetchJson(
    `https://www.thesportsdb.com/api/v2/json/livescore/${sport}`,
    { headers:{ "X-API-KEY":API_KEY } }
  );
  for (const m of tsdb?.livescore||[]) {
    if (results.length>=5) break;
    if (!majors.includes(m.strLeague)) continue;
    const fm = formatTSDB(m);
    results.push(fm);
    seen.add(fm.id);
  }

  // 2️⃣ ESPN upcoming (today + next 2 days)
  if (results.length<5) {
    const espnPath = getEspnPath(sport);
    for (let d=0; d<3 && results.length<5; d++) {
      const date = formatDateOffset(d);
      const espn = await fetchJson(
        `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard?dates=${date}`
      );
      for (const e of espn?.events||[]) {
        if (results.length>=5) break;
        if (seen.has(e.id)) continue;
        const fm = formatESPN(e,sport);
        if (!fm) continue;
        results.push(fm);
        seen.add(e.id);
      }
    }
  }

  // 3️⃣ ESPN completed (yesterday + 2 days prior)
  if (results.length<5) {
    const espnPath = getEspnPath(sport);
    for (let d=1; d<=3 && results.length<5; d++) {
      const date = formatDateOffset(-d);
      const espn = await fetchJson(
        `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard?dates=${date}`
      );
      for (const e of espn?.events||[]) {
        if (results.length>=5) break;
        if (seen.has(e.id)) continue;
        const fm = formatESPN(e,sport);
        if (!fm) continue;
        results.push(fm);
        seen.add(e.id);
      }
    }
  }

  return results;
}

// 9. Endpoints
app.get("/scores/soccer", async(_,res)=>{
  const m = await getMatches("soccer");
  res.json(m.length?m:[{headline:"No major soccer games right now."}]);
});
app.get("/scores/nba", async(_,res)=>{
  const m = await getMatches("basketball");
  res.json(m.length?m:[{headline:"No NBA games right now."}]);
});
app.get("/scores/nfl", async(_,res)=>{
  const m = await getMatches("american_football");
  res.json(m.length?m:[{headline:"No NFL games right now."}]);
});
app.get("/scores/nhl", async(_,res)=>{
  const m = await getMatches("ice_hockey");
  res.json(m.length?m:[{headline:"No NHL games right now."}]);
});

// 10. Debug
app.get("/scores/debug", async(req,res)=>{
  const url=req.query.url;
  if(!url) return res.status(400).send("Provide ?url=");
  try{ const t=await (await fetch(url)).text(); res.type("text/plain").send(t); }
  catch(e){ res.send("Error: "+e); }
});

app.listen(PORT,()=>console.log(`Listening on port ${PORT}`));