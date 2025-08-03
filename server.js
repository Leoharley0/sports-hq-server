const express = require("express");
const fetch   = require("node-fetch");
const app     = express();
const PORT    = process.env.PORT || 3000;

const API_KEY = "342128"; // your TheSportsDB key

// 1️⃣ Whitelist of major leagues for TSDB live filtering
const MAJOR = {
  soccer:            ["English Premier League","La Liga","UEFA Champions League"],
  basketball:        ["NBA"],
  american_football: ["NFL"],
  ice_hockey:        ["NHL"]
};

// 2️⃣ Default league names if ESPN omits them
const DEFAULT_LEAGUE = {
  soccer:            "Soccer",
  basketball:        "NBA",
  american_football: "NFL",
  ice_hockey:        "NHL"
};

// 3️⃣ Map our sport codes to ESPN scoreboard paths
function getEspnPath(sport) {
  switch (sport) {
    case "soccer":            return "soccer/eng.1";
    case "basketball":        return "basketball/nba";
    case "american_football": return "football/nfl";
    case "ice_hockey":        return "hockey/nhl";
    default:                   return sport;
  }
}

// 4️⃣ Helper to format YYYYMMDD offsets
function dateOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0,10).replace(/-/g,"");
}

// 5️⃣ Smart JSON fetch (only TSDB v2 needs header)
async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const txt = await res.text();
  if (txt.trim().startsWith("<!DOCTYPE") || txt.trim().startsWith("<html")) {
    return null;
  }
  return JSON.parse(txt);
}

// 6️⃣ Format a TSDB live match
function formatTSDB(m) {
  let status = "Scheduled";
  const s = (m.strStatus||"").toLowerCase();
  if (s.includes("live"))                status = "LIVE";
  else if (/finished|ended|ft/.test(s))   status = "Final";
  else if (m.dateEvent)                   status = `on ${m.dateEvent}`;

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

// 7️⃣ Format an ESPN match (upcoming or completed)
function formatESPN(e, sport) {
  const c  = e.competitions?.[0];
  const h  = c?.competitors.find(x=>x.homeAway==="home");
  const a  = c?.competitors.find(x=>x.homeAway==="away");
  if (!h||!a) return null;

  const started   = e.status?.type?.started;
  const completed = e.status?.type?.completed;
  let status = "Scheduled";
  if (started && !completed) status = "LIVE";
  else if (completed)         status = "Final";

  const leagueName = e.leagues?.[0]?.name || DEFAULT_LEAGUE[sport];

  return {
    id:       e.id,
    team1:    h.team.displayName,
    score1:   h.score || "N/A",
    team2:    a.team.displayName,
    score2:   a.score || "N/A",
    league:   leagueName,
    headline: `${h.team.displayName} vs ${a.team.displayName} - ${status}`
  };
}

// 8️⃣ Core: pull up to 5 matches per sport
async function getMatches(sport) {
  const results = [];
  const seen    = new Set();
  const majors  = MAJOR[sport] || [];

  // a) TSDB live (v2)
  const liveData = await fetchJson(
    `https://www.thesportsdb.com/api/v2/json/livescore/${sport}`,
    { headers:{ "X-API-KEY":API_KEY } }
  );
  for (const m of liveData?.livescore||[]) {
    if (results.length>=5) break;
    if (!majors.includes(m.strLeague)) continue;
    const fm = formatTSDB(m);
    results.push(fm);
    seen.add(fm.id);
  }

  // b) ESPN upcoming (today + next 2 days)
  if (results.length<5) {
    const path = getEspnPath(sport);
    for (let d=0; d<3 && results.length<5; d++) {
      const espn = await fetchJson(
        `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${dateOffset(d)}`
      );
      for (const e of espn?.events||[]) {
        if (results.length>=5) break;
        if (seen.has(e.id)) continue;
        const fm = formatESPN(e, sport);
        if (!fm) continue;
        // only include upcoming & live here
        if (e.status?.type?.started && !e.status?.type?.completed) {
          results.push(fm);
          seen.add(e.id);
        } else if (e.status?.type?.state==="PRE") {
          results.push(fm);
          seen.add(e.id);
        }
      }
    }
  }

  // c) ESPN completed (yesterday + 2 days prior)
  if (results.length<5) {
    const path = getEspnPath(sport);
    for (let d=1; d<=3 && results.length<5; d++) {
      const espn = await fetchJson(
        `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${dateOffset(-d)}`
      );
      for (const e of espn?.events||[]) {
        if (results.length>=5) break;
        if (seen.has(e.id)) continue;
        const fm = formatESPN(e, sport);
        if (!fm) continue;
        results.push(fm);
        seen.add(e.id);
      }
    }
  }

  return results;
}

// 9️⃣ HTTP endpoints
app.get("/scores/soccer",            async (req,res)=> {
  const m = await getMatches("soccer");
  res.json(m.length? m : [{headline:"No soccer games found."}]);
});
app.get("/scores/nba",               async (req,res)=> {
  const m = await getMatches("basketball");
  res.json(m.length? m : [{headline:"No NBA games found."}]);
});
app.get("/scores/nfl",               async (req,res)=> {
  const m = await getMatches("american_football");
  res.json(m.length? m : [{headline:"No NFL games found."}]);
});
app.get("/scores/nhl",               async (req,res)=> {
  const m = await getMatches("ice_hockey");
  res.json(m.length? m : [{headline:"No NHL games found."}]);
});

// 🔧 Debug any URL
app.get("/scores/debug", async (req,res)=> {
  const url = req.query.url;
  if (!url) return res.status(400).send("Provide ?url=");
  try {
    const t = await (await fetch(url)).text();
    res.type("text/plain").send(t);
  } catch (e) {
    res.send("Error: "+e);
  }
});

// 🔥 Start server
app.listen(PORT,()=> console.log(`Listening on port ${PORT}`));