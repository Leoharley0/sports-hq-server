const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your premium key

async function fetchJson(url) {
    try {
        const response = await fetch(url, {
            headers: { "apikey": API_KEY }
        });
        return await response.json();
    } catch (err) {
        console.error("Fetch error:", err);
        return null;
    }
}

// Generic function for a league
async function getLeagueScores(leagueId, sport = null) {
    let data = null;

    // 1. Try live (only if sport is provided, since v2 uses sport names)
    if (sport) {
        data = await fetchJson(`https://www.thesportsdb.com/api/v2/json/livescore/${sport}`);
        if (data && data.livescore && data.livescore.length > 0) {
            return data.livescore[0];
        }
    }

    // 2. Fallback: past games
    data = await fetchJson(`https://www.thesportsdb.com/api/v1/json/eventspastleague.php?id=${leagueId}`);
    if (data && data.events && data.events.length > 0) {
        return data.events[0];
    }

    // 3. Fallback: upcoming games
    data = await fetchJson(`https://www.thesportsdb.com/api/v1/json/eventsnextleague.php?id=${leagueId}`);
    if (data && data.events && data.events.length > 0) {
        return data.events[0];
    }

    return null;
}

// Routes for each sport
app.get("/scores/soccer", async (req, res) => {
    const match = await getLeagueScores(4328, "soccer"); // EPL
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

app.get("/scores/nba", async (req, res) => {
    const match = await getLeagueScores(4387); // NBA
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

app.get("/scores/nfl", async (req, res) => {
    const match = await getLeagueScores(4391); // NFL
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

app.get("/scores/nhl", async (req, res) => {
    const match = await getLeagueScores(4380); // NHL
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

app.listen(PORT, () => {
    console.log(`Sports HQ server running on http://localhost:${PORT}`);
});