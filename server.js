// server.js - Sports HQ using TheSportsDB V2 API with fallback

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your premium API key

app.get("/scores", async (req, res) => {
    try {
        // Try live soccer scores first
        let response = await fetch("https://www.thesportsdb.com/api/v2/json/livescore/soccer", {
            headers: {
                "apikey": API_KEY
            }
        });

        let data = await response.json();

        // If no live matches, fallback to past games
        if (!data || !data.livescore || data.livescore.length === 0) {
            console.log("No live games, falling back to past results...");
            response = await fetch(`https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventspastleague.php?id=4328`, { // 4328 = English Premier League
                headers: {
                    "apikey": API_KEY
                }
            });
            data = await response.json();
        }

        // Return the first available match
        if (data && (data.livescore?.length > 0 || data.events?.length > 0)) {
            const match = (data.livescore?.[0] || data.events?.[0]);
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
    } catch (error) {
        console.error("API fetch error:", error);
        res.json({ headline: "Error fetching scores." });
    }
});

app.listen(PORT, () => {
    console.log(`Sports HQ server running on http://localhost:${PORT}`);
});