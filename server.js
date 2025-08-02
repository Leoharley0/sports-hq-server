// server.js - Test server for Roblox Sports HQ
// This sends fake live scores to your Roblox game

const express = require("express");
const app = express();
const PORT = 3000; // server runs on localhost:3000

// Example sports data (later, you can connect to a real API)
let scores = {
    team1: "Lakers",
    score1: 102,
    team2: "Heat",
    score2: 98,
    headline: "Lakers take the lead in the final quarter!"
};

// Endpoint Roblox will call to get scores
app.get("/scores", (req, res) => {
    res.json(scores);
});

// Update the scores slightly every 20 seconds to simulate a live game
setInterval(() => {
    scores.score1 += Math.floor(Math.random() * 3); // add 0–2 points
    scores.score2 += Math.floor(Math.random() * 3);
}, 20000);

// Start the server
app.listen(PORT, () => {
    console.log(`Sports HQ server running on http://localhost:${PORT}`);
});