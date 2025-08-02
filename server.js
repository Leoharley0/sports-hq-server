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

async function getSportScores(sport, leagueId) {
    let data = null;

    // 1. Try live scores (v2)
    if (sport) {
        data = await fetchJson(`https://www.thesportsdb.com/api/v2/json/livescore/${sport}`);
        if (data && data.livescore && data.livescore.length > 0) {
            console.log(`Got live ${sport} data!`);
            const match = data.livescore[0];
            return {
                ...match,
                isLive: true
            };
        }
    }

    // 2. Past games (v1)
    data = await fetchJson(`https://www.thesportsdb.com/api/v1/json/eventspastleague.php?id=${leagueId}`);
    if (data && data.events && data.events.length > 0) {
        console.log(`Got past ${leagueId} results!`);
        const match = data.events[0];
        return {
            ...match,
            isLive: false
        };
    }

    // 3. Upcoming games (v1)
    data = await fetchJson(`https://www.thesportsdb.com/api/v1/json/eventsnextleague.php?id=${leagueId}`);
    if (data && data.events && data.events.length > 0) {
        console.log(`Got upcoming ${leagueId} schedule!`);
        const match = data.events[0];
        return {
            ...match,
            isLive: false
        };
    }

    return null;
}

function formatMatchResponse(match) {
    if (!match) return { headline: "No data available." };

    const headline = match.isLive
        ? `${match.strHomeTeam} vs ${match.strAwayTeam} - LIVE`
        : `${match.strHomeTeam} vs ${match.strAwayTeam} on ${match.dateEvent || "TBD"}`;

    return {
        team1: match.strHomeTeam,
        score1: match.intHomeScore || "N/A",
        team2: match.strAwayTeam,
        score2: match.intAwayScore || "N/A",
        headline: headline
    };
}

// Soccer
app.get("/scores/soccer", async (req, res) => {
    const match = await getSportScores("soccer", 4328);
    res.json(formatMatchResponse(match));
});

// NBA (Basketball)
app.get("/scores/nba", async (req, res) => {
    const match = await getSportScores("basketball", 4387);
    res.json(formatMatchResponse(match));
});

// NFL (American Football)
app.get("/scores/nfl", async (req, res) => {
    const match = await getSportScores("american_football", 4391);
    res.json(formatMatchResponse(match));
});

// NHL (Hockey)
app.get("/scores/nhl", async (req, res) => {
    const match = await getSportScores("hockey", 4380);
    res.json(formatMatchResponse(match));
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