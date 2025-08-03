const express = require("express");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your TheSportsDB key

// 1️⃣ Whitelist for TSDB live matches
const MAJOR = {
  soccer:            ["English Premier League", "La Liga", "UEFA Champions League"],
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

// 3️⃣ Map sport to ESPN path
function getEspnPath(sport) {
  switch (sport) {
    case "soccer":            return "soccer/eng.1";
    case "basketball":        return "basketball/nba";
    case "american_football": return "football/nfl";
    case "ice_hockey":        return "hockey/nhl";
    default:                   return sport;
  }
}

// 4️⃣ Smart JSON fetch (only TSDB v2 needs header)
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

// 5️⃣ Normalize a TSDB live match
function formatTSDB(m) {
  let status = "Scheduled";
  const s = (m.strStatus||"").toLowerCase();
  if (s.includes("live"))                status = "LIVE";
  else if (s.match(/finished|ended|ft/)) status = "Final";
  else if (m.dateEvent)                  status = `on ${m.dateEvent}`;

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

// 6️⃣ Normalize an ESPN upcoming match
function formatESPN(e, sport) {
  const comp = e.competitions?.[0];
  const home = comp?.competitors.find(c => c.homeAway==="home");
  const away = comp?.competitors.find(c => c.homeAway==="away");
  if (!home || !away) return null;

  // Only upcoming: state PRE
  if (e.status?.type?.state !== "PRE") return null;

  const leagueName = e.leagues?.[0]?.name || DEFAULT_LEAGUE[sport];

  return {
    id:       e.id,
    team1:    home.team.displayName,
    score1:   home.score     || "N/A",
    team2:    away.team.displayName,
    score2:   away.score     || "N/A",
    league:   leagueName,
    headline: `${home.team.displayName} vs ${away.team.displayName} - Scheduled`
  };
}

// 7️⃣ Core: live → upcoming (no completed), cap at 5
async function getMatches(sport) {
  const results = [];
  const seen    = new Set();
  const majors  = MAJOR[sport] || [];

  // TSDB live
  const tsdb = await fetchJson(
    `https://www.thesportsdb.com/api/v2/json/livescore/${sport}`,
    { headers:{ "X-API-KEY": API_KEY } }
  );
  for (const m of tsdb?.livescore||[]) {
    if (results.length >= 5) break;
    if (!majors.includes(m.strLeague)) continue;
    const fm = formatTSDB(m);
    results.push(fm);
    seen.add(fm.id);
  }

  // ESPN upcoming only
  if (results.length < 5) {
    const path = getEspnPath(sport);
    const espn = await fetchJson(
      `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`
    );
    for (const e of espn?.events||[]) {
      if (results.length >= 5) break;
      if (seen.has(e.id)) continue;
      const fm = formatESPN(e, sport);
      if (!fm) continue;
      results.push(fm);
      seen.add(e.id);
    }
  }

  return results;
}

// 8️⃣ HTTP endpoints
app.get("/scores/soccer",            async (req,res) => { const m=await getMatches("soccer");            res.json(m.length?m:[{headline:"No major soccer or upcoming games available."}]); });
app.get("/scores/nba",               async (req,res) => { const m=await getMatches("basketball");        res.json(m.length?m:[{headline:"No NBA or upcoming games available."}]); });
app.get("/scores/nfl",               async (req,res) => { const m=await getMatches("american_football"); res.json(m.length?m:[{headline:"No NFL or upcoming games available."}]); });
app.get("/scores/nhl",               async (req,res) => { const m=await getMatches("ice_hockey");        res.json(m.length?m:[{headline:"No NHL or upcoming games available."}]); });

// 9️⃣ Debug any URL
app.get("/scores/debug", async (req,res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Provide ?url=");
  try { const t = await (await fetch(url)).text(); res.type("text/plain").send(t); }
  catch(e){ res.send("Error: "+e); }
});

app.listen(PORT, () => console.log(`Running on port ${PORT}`));