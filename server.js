// server.js - Sports HQ with triple fallback: live → past → upcoming

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

app.get("/scores/soccer", async (req, res) => {
    let data = await fetchJson("https://www.thesportsdb.com/api/v2/json/livescore/soccer");

    // Fallback 1: past games
    if (!data || !data.livescore || data.livescore.length === 0) {
        console.log("No live games, trying past results...");
        data = await fetchJson(`https://www.thesportsdb.com/api/v1/json/eventspastleague.php?id=4328`);
    }

    // Fallback 2: upcoming games
    if (!data || !data.events || data.events.length === 0) {
        console.log("No past games, trying upcoming...");
        data = await fetchJson(`https://www.thesportsdb.com/api/v1/json/eventsnextleague.php?id=4328`);
    }

    // Return whichever worked
    if (data && (data.livescore?.length > 0 || data.events?.length > 0)) {
        const match = data.livescore?.[0] || data.events?.[0];
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

app.listen(PORT, () => {
    console.log(`Sports HQ server running on http://localhost:${PORT}`);
});