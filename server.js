// server.js - Multi-sport HQ with proper headers

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your premium key

// Helper function for fetch with headers
async function fetchJson(url) {
    try {
        const response = await fetch(url, {
            headers: {
                "apikey": API_KEY
            }
        });
        return await response.json();
    } catch (err) {
        console.error("Fetch error:", err);
        return null;
    }
}

// Soccer endpoint: V2 live → V1 fallback
app.get("/scores/soccer", async (req, res) => {
    let data = await fetchJson("https://www.thesportsdb.com/api/v2/json/livescore/soccer");

    if (!data || !data.livescore || data.livescore.length === 0) {
        console.log("No live games, falling back to past results...");
        data = await fetchJson("https://www.thesportsdb.com/api/v1/json/eventspastleague.php?id=4328");
    }

    if (data && (data.livescore?.length > 0 || data.events?.length > 0)) {
        const match = data.livescore?.[0] || data.events?.[0];
        res.json({
            team1: match.strHomeTeam,
            score1: match.intHomeScore,
            team2: match.strAwayTeam,
            score2: match.intAwayScore,
            headline: `${match.strHomeTeam} vs ${match.strAwayTeam}`
        });
    } else {
        res.json({ headline: "No soccer data available." });
    }
});

app.listen(PORT, () => {
    console.log(`Sports HQ server running on http://localhost:${PORT}`);
});