const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your premium key

async function fetchJson(url) {
    try {
        const res = await fetch(url, { headers: { "X-API-KEY": API_KEY } });
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

// Whitelisted big leagues
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

async function getLiveMatches(sport) {
    const data = await fetchJson(`https://www.thesportsdb.com/api/v2/json/livescore/${sport}`);
    if (!data || !data.livescore) return [];

    // Filter to only major leagues
    const majorLeagues = MAJOR_LEAGUES[sport] || [];
    return data.livescore
        .filter(m => majorLeagues.includes(m.strLeague))
        .map(formatMatch)
        .slice(0, 5);
}

// Soccer
app.get("/scores/soccer", async (req, res) => {
    const matches = await getLiveMatches("soccer");
    res.json(matches.length ? matches : [{ headline: "No live major soccer games available." }]);
});

// NBA
app.get("/scores/nba", async (req, res) => {
    const matches = await getLiveMatches("basketball");
    res.json(matches.length ? matches : [{ headline: "No live NBA games available." }]);
});

// NFL
app.get("/scores/nfl", async (req, res) => {
    const matches = await getLiveMatches("american_football");
    res.json(matches.length ? matches : [{ headline: "No live NFL games available." }]);
});

// NHL (try ice_hockey)
app.get("/scores/nhl", async (req, res) => {
    const matches = await getLiveMatches("ice_hockey");
    res.json(matches.length ? matches : [{ headline: "No live NHL games available." }]);
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