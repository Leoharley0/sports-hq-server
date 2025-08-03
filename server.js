const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your premium key

async function fetchJson(url) {
    try {
        const response = await fetch(url, {
            headers: { "X-API-KEY": API_KEY }
        });
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

// Fetch soccer matches with popularity filter
async function getPopularSoccerMatches() {
    let matches = [];

    // Live soccer
    let data = await fetchJson("https://www.thesportsdb.com/api/v2/json/livescore/soccer");
    if (data && data.livescore) {
        matches.push(...data.livescore);
    }

    // Past EPL as fallback
    data = await fetchJson("https://www.thesportsdb.com/api/v1/json/eventspastleague.php?id=4328"); // EPL
    if (data && data.events) {
        matches.push(...data.events);
    }

    // Filter to only popular leagues
    matches = matches.filter(m => POPULAR_SOCCER_LEAGUES.includes(m.strLeague));

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

    return matches.slice(0, 5); // limit to 5 matches
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

// Reuse getSportScores from before
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

    data = await fetchJson(`https://www.thesportsdb.com/api/v1/json/eventspastleague.php?id=${leagueId}`);
    if (data && data.events && data.events.length > 0) {
        const match = data.events[0];
        match.isLive = false;
        return match;
    }

    data = await fetchJson(`https://www.thesportsdb.com/api/v1/json/eventsnextleague.php?id=${leagueId}`);
    if (data && data.events && data.events.length > 0) {
        const match = data.events[0];
        match.isLive = false;
        return match;
    }

    return null;
}