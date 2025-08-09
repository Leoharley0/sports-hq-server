// server.js
const express = require("express");
const fetch   = require("node-fetch");

const app     = express();
const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.TSDB_KEY || "<342128>";

// --- helpers ---------------------------------------------------------------
async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (e) {
    console.error("fetchJson error:", e.message, "→", url);
    return null;
  }
}

function isLiveStatus(s = "") {
  const t = String(s).toLowerCase();
  return t.includes("live") || t.includes("in play") ||
         /^q\d/.test(t) || t.includes("quarter") ||
         t.includes("ot") || t.includes("overtime") ||
         t.includes("half");
}

function isFinalStatus(s = "") {
  const t = String(s).toLowerCase();
  return t.includes("final") || t === "ft" || t.includes("full time");
}

function pickScore(v) {
  return (v === undefined || v === null || v === "" || v === "N/A") ? null : v;
}

function formatMatch(m) {
  // team names
  const home = m.strHomeTeam || m.homeTeam || m.strHome || "";
  const away = m.strAwayTeam || m.awayTeam || m.strAway || "";

  // scores (try a few common fields across sports)
  const s1 = pickScore(m.intHomeScore ?? m.intHomeScoreTotal ?? m.intHomeScore1 ?? m.intHomeGoals);
  const s2 = pickScore(m.intAwayScore ?? m.intAwayScoreTotal ?? m.intAwayScore1 ?? m.intAwayGoals);

  // status normalize
  const raw = m.strStatus || m.strProgress || m.strTime || "Scheduled";
  let status = "Scheduled";
  if (isLiveStatus(raw)) status = "LIVE";
  else if (raw === "NS") status = "Scheduled";
  else if (isFinalStatus(raw)) status = "Final";
  else status = raw;

  return {
    team1: home,
    team2: away,
    score1: s1 === null ? "N/A" : String(s1),
    score2: s2 === null ? "N/A" : String(s2),
    headline: `${home} vs ${away} - ${status}`,
  };
}

// ensure uniqueness by idEvent (or match key)
function pushUnique(arr, m) {
  const key = m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent}|${m.strTime}`;
  if (!arr.some(x => (x.idEvent || `${x.strHomeTeam}|${x.strAwayTeam}|${x.dateEvent}|${x.strTime}`) === key)) {
    arr.push(m);
  }
}

// --- core fetch: live then upcoming (fill to 5) ---------------------------
async function getLeagueMatches(sport, leagueId) {
  const out = [];

  // 1) LIVE (try both v2 URL styles)
  const liveA = await fetchJson(`https://www.thesportsdb.com/api/v2/json/${API_KEY}/livescore/${sport}`);
  const liveB = liveA && liveA.livescore ? null
               : await fetchJson(`https://www.thesportsdb.com/api/v2/json/${API_KEY}/livescore.php?s=${sport}`);
  const live  = (liveA && liveA.livescore) ? liveA.livescore
               : (liveB && liveB.livescore) ? liveB.livescore : [];

  // filter live by league (if the payload includes idLeague)
  for (const m of live || []) {
    if (!leagueId || !m.idLeague || String(m.idLeague) === String(leagueId)) {
      pushUnique(out, m);
    }
  }

  // 2) UPCOMING (fill to 5)
  if (out.length < 5) {
    const up = await fetchJson(`https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventsnextleague.php?id=${leagueId}`);
    const events = (up && up.events) ? up.events : [];
    // sort by date/time ascending
    events.sort((a, b) => {
      const da = new Date(`${a.dateEvent} ${a.strTime || "00:00:00"}Z`);
      const db = new Date(`${b.dateEvent} ${b.strTime || "00:00:00"}Z`);
      return da - db;
    });
    for (const m of events) {
      if (out.length >= 5) break;
      pushUnique(out, m);
    }
  }

  return out.slice(0, 5);
}

// --- endpoints -------------------------------------------------------------
const CONFIGS = {
  "/scores/soccer":            { sport: "soccer",            leagueId: 4328 }, // EPL
  "/scores/nba":               { sport: "basketball",        leagueId: 4387 },
  "/scores/nfl":               { sport: "american_football", leagueId: 4391 },
  "/scores/nhl":               { sport: "ice_hockey",        leagueId: 4380 },
};

for (const [path, cfg] of Object.entries(CONFIGS)) {
  app.get(path, async (req, res) => {
    try {
      const matches = await getLeagueMatches(cfg.sport, cfg.leagueId);
      // debug log: teams + raw statuses
      console.log(`${path} →`,
        matches.map(m => `${m.strHomeTeam} v ${m.strAwayTeam} | ${m.strStatus || m.strProgress || m.strTime || "Scheduled"}`)
      );
      res.json(matches.map(formatMatch));
    } catch (e) {
      console.error(path, "handler error:", e);
      res.status(500).json({ error: "internal" });
    }
  });
}

app.get("/", (_, res) => res.send("Sports HQ server ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));