const express = require("express");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your TheSportsDB key

// Smart fetch: TSDB header only on TSDB v2 calls
async function fetchJson(url) {
  try {
    const opts = url.includes("thesportsdb.com/api/v2/")
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

// Whitelist of big leagues per sport
const MAJOR = {
  soccer: [
    "English Premier League",
    "La Liga",
    "UEFA Champions League"
  ],
  basketball: ["NBA"],
  american_football: ["NFL"],
  ice_hockey: ["NHL"]
};

// League IDs for TSDB fallback (not used here but kept for reference)
const LEAGUE_IDS = {
  soccer: 4328,
  basketball: 4387,
  american_football: 4391,
  ice_hockey: 4380
};

// ESPN slug for each sport
function getEspnSlug(sport) {
  switch (sport) {
    case "soccer":           return "soccer/eng.1";
    case "basketball":       return "basketball/nba";
    case "american_football":return "football/nfl";
    case "ice_hockey":       return "hockey/nhl";
    default:                 return sport;
  }
}

function formatMatch(m) {
  let status = "Scheduled";
  const s = (m.strStatus||"").toLowerCase();
  if (s.includes("live"))       status = "LIVE";
  else if (s.includes("finished")||s.includes("ended")||s.includes("ft"))
                                status = "Final";
  else if (m.dateEvent)         status = `on ${m.dateEvent}`;

  return {
    team1: m.strHomeTeam,
    score1: m.intHomeScore  || "N/A",
    team2: m.strAwayTeam,
    score2: m.intAwayScore  || "N/A",
    league: m.strLeague,
    headline: `${m.strHomeTeam} vs ${m.strAwayTeam} - ${status}`
  };
}

async function getMatches(sport) {
  const results = [];
  const majors = MAJOR[sport] || [];
  const espnSlug = getEspnSlug(sport);

  // 1️⃣ Live from TheSportsDB
  const liveData = await fetchJson(
    `https://www.thesportsdb.com/api/v2/json/livescore/${sport}`
  );
  for (const m of liveData?.livescore||[]) {
    if (results.length>=5) break;
    if (majors.includes(m.strLeague)) results.push(formatMatch(m));
  }

  // 2️⃣ Upcoming & Completed from ESPN
  if (results.length < 5) {
    const espnUrl = `https://site.api.espn.com/apis/site/v2/sports/${espnSlug}/scoreboard`;
    const espn = await fetchJson(espnUrl);

    for (const e of espn?.events||[]) {
      if (results.length>=5) break;
      const comp = e.competitions?.[0];
      if (!comp) continue;

      const home = comp.competitors.find(c=>c.homeAway==="home");
      const away = comp.competitors.find(c=>c.homeAway==="away");
      if (!home||!away) continue;

      // Only major league events
      if (!majors.includes(e.league?.name||espn.sports?.[0]?.name)) continue;

      // Determine status
      let state = e.status?.type?.state || "";
      let status = state==="PRE" ? "Scheduled"
                 : state==="IN"  ? "LIVE"
                 :               "Final";

      results.push({
        team1: home.team.displayName,
        score1: home.score || "N/A",
        team2: away.team.displayName,
        score2: away.score || "N/A",
        league: espn.sports?.[0]?.name || "",
        headline: `${home.team.displayName} vs ${away.team.displayName} - ${status}`
      });
    }
  }

  return results;
}

// Four endpoints
app.get("/scores/soccer", async (req, res) => {
  const m = await getMatches("soccer");
  res.json(m.length? m : [{ headline: "No major soccer games right now." }]);
});
app.get("/scores/nba", async (req, res) => {
  const m = await getMatches("basketball");
  res.json(m.length? m : [{ headline: "No NBA games right now." }]);
});
app.get("/scores/nfl", async (req, res) => {
  const m = await getMatches("american_football");
  res.json(m.length? m : [{ headline: "No NFL games right now." }]);
});
app.get("/scores/nhl", async (req, res) => {
  const m = await getMatches("ice_hockey");
  res.json(m.length? m : [{ headline: "No NHL games right now." }]);
});

// Debug route (any URL)
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

app.listen(PORT, () => {
  console.log(`Sports HQ listening on port ${PORT}`);
});
