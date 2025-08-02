const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your premium key

async function fetchJson(url) {
    try {
        const response = await fetch(url, {
            headers: {
                "X-API-KEY": API_KEY
            }
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

async function getLeagueScores(leagueId, sport = null) {
    let data = null;

    // 1. Live scores (only for sports v2 supports)
    if (sport) {
        data = await fetchJson(`https://www.thesportsdb.com/api/v2/json/livescore/${sport}`);
        if (data && data.livescore && data.livescore.length > 0) {
            console.log(`Got live ${sport} data!`);
            return data.livescore[0];
        }
    }

    // 2. Past games
    data = await fetchJson(`https://www.thesportsdb.com/api/v1/json/eventspastleague.php?id=${leagueId}`);
    if (data && data.events && data.events.length > 0) {
        console.log(`Got past ${leagueId} results!`);
        return data.events[0];
    }

    // 3. Upcoming games
    data = await fetchJson(`https://www.thesportsdb.com/api/v1/json/eventsnextleague.php?id=${leagueId}`);
    if (data && data.events && data.events.length > 0) {
        console.log(`Got upcoming ${leagueId} schedule!`);
        return data.events[0];
    }

    return null;
}

// Soccer (EPL)
app.get("/scores/soccer", async (req, res) => {
    const match = await getLeagueScores(4328, "soccer");
    if (match) {
        res.json({
            team1: match.strHomeTeam,
            score1: match.intHomeScore || "N/A",
            team2: match.strAwayTeam,
            score2: match.intAwayScore || "N/A",
            headline: `${match.strHomeTeam} vs ${match.strAwayTeam}`
        });
    } else {
        res.json({ headline: "No soccer data available." });
    }
});

// NBA
app.get("/scores/nba", async (req, res) => {
    const match = await getLeagueScores(4387);
    if (match) {
        res.json({
            team1: match.strHomeTeam,
            score1: match.intHomeScore || "N/A",
            team2: match.strAwayTeam,
            score2: match.intAwayScore || "N/A",
            headline: `${match.strHomeTeam} vs ${match.strAwayTeam}`
        });
    } else {
        res.json({ headline: "No NBA data available." });
    }
});

// NFL
app.get("/scores/nfl", async (req, res) => {
    const match = await getLeagueScores(4391);
    if (match) {
        res.json({
            team1: match.strHomeTeam,
            score1: match.intHomeScore || "N/A",
            team2: match.strAwayTeam,
            score2: match.intAwayScore || "N/A",
            headline: `${match.strHomeTeam} vs ${match.strAwayTeam}`
        });
    } else {
        res.json({ headline: "No NFL data available." });
    }
});

// NHL
app.get("/scores/nhl", async (req, res) => {
    const match = await getLeagueScores(4380);
    if (match) {
        res.json({
            team1: match.strHomeTeam,
            score1: match.intHomeScore || "N/A",
            team2: match.strAwayTeam,
            score2: match.intAwayScore || "N/A",
            headline: `${match.strHomeTeam} vs ${match.strAwayTeam}`
        });
    } else {
        res.json({ headline: "No NHL data available." });
    }
});

// Debug: raw API output
app.get("/scores/debug", async (req, res) => {
    try {
        const response = await fetch("https://www.thesportsdb.com/api/v2/json/livescore/soccer", {
            headers: { "X-API-KEY": API_KEY }
        });
        const text = await response.text();
        res.send(text);
    } catch (err) {
        res.send("Error fetching debug data: " + err);
    }
});

app.listen(PORT, () => {
    console.log(`Sports HQ server running on http://localhost:${PORT}`);
});