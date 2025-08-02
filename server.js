// server.js - Real scores for Roblox Sports HQ

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// Replace with your TheSportsDB API key (make sure it's a string!)
const API_KEY = "342128"; 

app.get("/scores", async (req, res) => {
    try {
        // Call TheSportsDB API for live basketball games
        const response = await fetch(`https://www.thesportsdb.com/api/v1/json/${API_KEY}/livescore.php?s=Basketball`);
        const text = await response.text();

        try {
            // Try to parse the response as JSON
            const data = JSON.parse(text);

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
        } catch (jsonErr) {
            // Log the first part of the response if it wasn't JSON
            console.error("Non-JSON response from API:", text.slice(0, 200));
            res.json({ headline: "Error: API returned non-JSON response" });
        }

    } catch (error) {
        console.error("API fetch error:", error);
        res.json({ headline: "Error fetching scores." });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Sports HQ server running on http://localhost:${PORT}`);
});