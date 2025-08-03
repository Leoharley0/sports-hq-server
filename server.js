const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your premium key

// Smart fetch: only send header for v2 requests
async function fetchJson(url) {
    try {
        const options = {};
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
    "UEFA Champions League"
];

// In-memory cache
let soccerCache = { data: [], timestamp: 0 };
let otherSportsCache = { nba: null, nfl: null, nhl: null, timestamp: 0 };

async function fetchSoccerMatches() {
    let matches = [];

    // Live soccer (v2)
    let data = await fetchJson("https://www.thesportsdb.com/api/v2/json/livescore/soccer");
    if (data && data.livescore) {
        matches.push(...data.livescore);
    }

    // Past & Upcoming from EPL, La Liga, UCL (v1)
    const leagueIds = [4328, 4335, 4480];
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

    return matches.slice(0, 5);
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

// Soccer endpoint with caching
app.get("/scores/soccer", async (req, res) => {
    const now = Date.now();

    if (now - soccerCache.timestamp > 60000) { // refresh every 60s
        console.log("Refreshing soccer cache...");
        soccerCache.data = await fetchSoccerMatches();
        soccerCache.timestamp = now;
    }

    if (!soccerCache.data || soccerCache.data.length === 0) {
        return res.json([{ headline: "No major soccer games available." }]);
    }

    res.json(soccerCache.data.map(formatMatch));
});

// Generic sports function with caching
async function getSportScoresCached(sport, leagueId, key) {
    const now = Date.now();

    if (now - otherSportsCache.timestamp > 60000) {
        console.log("Refreshing other sports cache...");
        otherSportsCache.timestamp = now;

        otherSportsCache[key] = await (async () => {
            let match = null;
            let data = await fetchJson(`https://www.thesportsdb.com/api/v2/json/livescore/${sport}`);
            if (data && data.livescore && data.livescore.length > 0) {
                match = data.livescore[0];
                match.isLive = match.strStatus && match.strStatus.toLowerCase().includes("live");
            } else {
                data = await fetchJson(`https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventspastleague.php?id=${leagueId}`);
                if (data && data.events && data.events.length > 0) match = data.events[0];
                else {
                    data = await fetchJson(`https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventsnextleague.php?id=${leagueId}`);
                    if (data && data.events && data.events.length > 0) match = data.events[0];
                }
            }
            return match;
        })();
    }

    return otherSportsCache[key];
}

// NBA
app.get("/scores/nba", async (req, res) => {
    const match = await getSportScoresCached("basketball", 4387, "nba");
    res.json(match ? formatMatch(match) : { headline: "No NBA data available." });
});

// NFL
app.get("/scores/nfl", async (req, res) => {
    const match = await getSportScoresCached("american_football", 4391, "nfl");
    res.json(match ? formatMatch(match) : { headline: "No NFL data available." });
});

// NHL
app.get("/scores/nhl", async (req, res) => {
    const match = await getSportScoresCached("hockey", 4380, "nhl");
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