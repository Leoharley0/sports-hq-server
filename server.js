const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your premium key

// Smart fetch: only send header for v2 requests
async function fetchJson(url) {
    try {
        const options = {};

        // Only add API key header for v2 requests
        if (url.includes("/v2/")) {
            options.headers = { "X-API-KEY": API_KEY };
        }

        const response = await fetch(url, options);
        const text = await response.text();

        try {
            return JSON.parse(text);
        } catch {
            console.error("Non-JSON response:", text.slice(0, 200));
            return null;
        }
    } catch (err) {
        console.error("Fetch error:", err);
        return null;
    }
}

// Popular soccer leagues
const POPULAR_SOCCER_LEAGUES = [
    "English Premier League",
    "La Liga",
    "Serie A",
    "Bundesliga",
    "Ligue 1",
    "UEFA Champions League",
    "UEFA Europa League",
    "FIFA World Cup",
    "UEFA Euro Championship",
    "Copa America"
];

async function getPopularSoccerMatches() {
    let matches = [];

    // 1. Live soccer (v2)
    let data = await fetchJson("https://www.thesportsdb.com/api/v2/json/livescore/soccer");
    if (data && data.livescore) {
        matches.push(...data.livescore);
    }

    // 2. Past & Upcoming from multiple big leagues (v1)
    const leagueIds = [4328, 4335, 4332, 4331, 4334, 4480, 4481, 4673, 4674, 4482];
    for (let id of leagueIds) {
        let past = await fetchJson(`https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventspastleague.php?id=${id}`);
        if (past && past.events) matches.push(...past.events);

        let next = await fetchJson(`https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventsnextleague.php?id=${id}`);
        if (next && next.events) matches.push(...next.events);
    }

    // Filter to only popular leagues
    matches = matches.filter(m =>
        POPULAR_SOCCER_LEAGUES.includes(m.strLeague) && m.strLeague !== "Test League"
    );

    // Deduplicate
    const seen = new Set();
    matches = matches.filter(m => {
        if (seen.has(m.idEvent)) return false;
        seen.add(m.idEvent);
        return true;
    });

    // Sort: live > final > scheduled
    matches.sort((a, b) => {
        const score = (m) => {
            if (m.strStatus && m.strStatus.toLowerCase().includes("live")) return 2;
            if (m.intHomeScore && m.intAwayScore) return 1;
            return 0;
        };
        return score(b) - score(a);
    });

    return matches.slice(0, 5); // top 5
}

function formatMatch(match) {
    let statusText = "Scheduled";

    if (match.strStatus) {
        const status = match.strStatus.toLowerCase();
        if (status.includes("live")) statusText = "LIVE";
        else if (status.includes("finished") || status.includes("ended") || status.includes("ft")) statusText = "Final";
        else statusText = match.dateEvent ? `on ${match.dateEvent}` : "Scheduled";
    } else {
        if (match.intHomeScore && match.intAwayScore) {
            statusText = "Final";
        } else {
            statusText = match.dateEvent ? `on ${match.dateEvent}` : "Scheduled";
        }
    }

    return {
        team1: match.strHomeTeam,
        score1: match.intHomeScore || "N/A",
        team2: match.strAwayTeam,
        score2: match.intAwayScore || "N/A",
        league: match.strLeague,
        headline: `${match.strHomeTeam} vs ${match.strAwayTeam} - ${statusText}`
    };
}

// Soccer endpoint
app.get("/scores/soccer", async (req, res) => {
    const matches = await getPopularSoccerMatches();
    if (matches.length === 0) {
        return res.json([{ headline: "No major soccer games available." }]);
    }
    res.json(matches.map(formatMatch));
});

// Generic sports function for NBA/NFL/NHL
async function getSportScores(sport, leagueId) {
    let data = null;

    if (sport) {
        data = await fetchJson(`https://www.thesportsdb.com/api/v2/json/livescore/${sport}`);
        if (data && data.livescore && data.livescore.length > 0) {
            const match = data.livescore[0];
            match.isLive = match.strStatus && match.strStatus.toLowerCase().includes("live");
            return match;
        }
    }

    data = await fetchJson(`https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventspastleague.php?id=${leagueId}`);
    if (data && data.events && data.events.length > 0) {
        const match = data.events[0];
        match.isLive = false;
        return match;
    }

    data = await fetchJson(`https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventsnextleague.php?id=${leagueId}`);
    if (data && data.events && data.events.length > 0) {
        const match = data.events[0];
        match.isLive = false;
        return match;
    }

    return null;
}

// NBA
app.get("/scores/nba", async (req, res) => {
    const match = await getSportScores("basketball", 4387);
    res.json(match ? formatMatch(match) : { headline: "No NBA data available." });
});

// NFL
app.get("/scores/nfl", async (req, res) => {
    const match = await getSportScores("american_football", 4391);
    res.json(match ? formatMatch(match) : { headline: "No NFL data available." });
});

// NHL
app.get("/scores/nhl", async (req, res) => {
    const match = await getSportScores("hockey", 4380);
    res.json(match ? formatMatch(match) : { headline: "No NHL data available." });
});

// Debug route
app.get("/scores/debug", async (req, res) => {
    const target = req.query.url || "https://www.thesportsdb.com/api/v2/json/livescore/soccer";
    try {
        const response = await fetch(target, {
            headers: { "X-API-KEY": API_KEY }
        });
        const text = await response.text();
        res.setHeader("Content-Type", "text/plain");
        res.send(text);
    } catch (err) {
        res.send("Error fetching debug data: " + err);
    }
});

app.listen(PORT, () => {
    console.log(`Sports HQ server running on http://localhost:${PORT}`);
});