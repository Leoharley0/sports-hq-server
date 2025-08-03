const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your premium key

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
    } catch (err) {
        console.error("Fetch error:", err);
        return null;
    }
}

const MAJOR_LEAGUES = {
    soccer: [
        "English Premier League",
        "La Liga",
        "Serie A",
        "Bundesliga",
        "Ligue 1",
        "UEFA Champions League",
        "FIFA World Cup"
    ],
    basketball: ["NBA"],
    american_football: ["NFL"],
    ice_hockey: ["NHL"]
};

function formatMatch(m) {
    let status = "Scheduled";
    if (m.strStatus) {
        const s = m.strStatus.toLowerCase();
        if (s.includes("live")) status = "LIVE";
        else if (s.includes("finished") || s.includes("ended") || s.includes("ft")) status = "Final";
        else status = m.dateEvent ? `on ${m.dateEvent}` : "Scheduled";
    } else {
        if (m.intHomeScore && m.intAwayScore) status = "Final";
        else if (m.dateEvent) status = `on ${m.dateEvent}`;
    }

    return {
        team1: m.strHomeTeam,
        score1: m.intHomeScore || "N/A",
        team2: m.strAwayTeam,
        score2: m.intAwayScore || "N/A",
        league: m.strLeague,
        headline: `${m.strHomeTeam} vs ${m.strAwayTeam} - ${status}`
    };
}

async function getMatches(sport, leagueId) {
    let matches = [];

    // 1. Live (v2)
    let live = await fetchJson(`https://www.thesportsdb.com/api/v2/json/livescore/${sport}`);
    if (live?.livescore) {
        matches.push(...live.livescore);
    }

    if (matches.length < 5) {
        // 2. Upcoming (v1)
        let upcoming = await fetchJson(`https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventsnextleague.php?id=${leagueId}`);
        if (upcoming?.events) matches.push(...upcoming.events);
    }

    if (matches.length < 5) {
        // 3. Completed (v1)
        let past = await fetchJson(`https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventspastleague.php?id=${leagueId}`);
        if (past?.events) matches.push(...past.events);
    }

    // Filter to only major leagues
    const majors = MAJOR_LEAGUES[sport] || [];
    matches = matches.filter(m => majors.includes(m.strLeague));

    // Deduplicate
    const seen = new Set();
    matches = matches.filter(m => {
        if (seen.has(m.idEvent)) return false;
        seen.add(m.idEvent);
        return true;
    });

    return matches.slice(0, 5).map(formatMatch);
}

// Soccer
app.get("/scores/soccer", async (req, res) => {
    const matches = await getMatches("soccer", 4328);
    res.json(matches.length ? matches : [{ headline: "No major soccer games available." }]);
});

// NBA
app.get("/scores/nba", async (req, res) => {
    const matches = await getMatches("basketball", 4387);
    res.json(matches.length ? matches : [{ headline: "No NBA games available." }]);
});

// NFL
app.get("/scores/nfl", async (req, res) => {
    const matches = await getMatches("american_football", 4391);
    res.json(matches.length ? matches : [{ headline: "No NFL games available." }]);
});

// NHL
app.get("/scores/nhl", async (req, res) => {
    const matches = await getMatches("ice_hockey", 4380);
    res.json(matches.length ? matches : [{ headline: "No NHL games available." }]);
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