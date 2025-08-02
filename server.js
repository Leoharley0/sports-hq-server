// server.js - Real scores for Roblox Sports HQ

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// Replace with your TheSportsDB API key
const API_KEY = 342128; 

app.get("/scores", async (req, res) => {
    try {
        // Fetch live basketball games
        const response = await fetch(`https://www.thesportsdb.com/api/v1/json/${API_KEY}/livescore.php?s=Basketball`);
        const data = await response.json();

        if (data && data.events && data.events.length > 0) {
            const match = data.events[0]; // show first live match
            res.json({
                team1: match.strHomeTeam,
                score1: match.intHomeScore,
                team2: match.strAwayTeam,
                score2: match.intAwayScore,
                headline: `${match.strHomeTeam} vs ${match.strAwayTeam} is live!`
            });
        } else {
            res.json({ headline: "No live basketball games right now." });
        }
    } catch (error) {
        console.error("API fetch error:", error);
        res.json({ headline: "Error fetching scores." });
    }
});

app.listen(PORT, () => {
    console.log(`Sports HQ server running on http://localhost:${PORT}`);
});