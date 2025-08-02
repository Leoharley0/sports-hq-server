// server.js - Sports HQ using TheSportsDB V2 API with header key

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your premium API key

app.get("/scores", async (req, res) => {
    try {
        const response = await fetch("https://www.thesportsdb.com/api/v2/json/livescore/soccer", {
            headers: {
                "apikey": API_KEY
            }
        });

        const data = await response.json();

        if (data && data.livescore && data.livescore.length > 0) {
            const match = data.livescore[0];
            res.json({
                team1: match.strHomeTeam,
                score1: match.intHomeScore,
                team2: match.strAwayTeam,
                score2: match.intAwayScore,
                headline: `${match.strHomeTeam} vs ${match.strAwayTeam} is live!`
            });
        } else {
            res.json({ headline: "No live soccer games right now." });
        }
    } catch (error) {
        console.error("API fetch error:", error);
        res.json({ headline: "Error fetching scores." });
    }
});

app.listen(PORT, () => {
    console.log(`Sports HQ server running on http://localhost:${PORT}`);
});