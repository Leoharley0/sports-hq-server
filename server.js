const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "342128"; // your premium key

async function fetchJson(url) {
    try {
        const response = await fetch(url, {
            headers: {
                "apikey": API_KEY
            }
        });

        const text = await response.text();

        try {
            return JSON.parse(text);
        } catch (err) {
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

    // 1. Try live (v2)
    if (sport) {
        data = await fetchJson(`https://www.thesportsdb.com/api/v2/json/livescore/${sport}`);
        if (data && data.livescore && data.livescore.length > 0) {
            console.log("Got live data!");
            return data.livescore[0];
        }
    }

    // 2. Past games (v1)
    data = await fetchJson(`https://www.thesportsdb.com/api/v1/json/eventspastleague.php?id=${leagueId}`);
    if (data && data.events && data.events.length > 0) {
        console.log("Got past results!");
        return data.events[0];
    }

    // 3. Upcoming games (v1)
    data = await fetchJson(`https://www.thesportsdb.com/api/v1/json/eventsnextleague.php?id=${leagueId}`);
    if (data && data.events && data.events.length > 0) {
        console.log("Got upcoming schedule!");
        return data.events[0];
    }

    return null;
}

// Routes
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

app.listen(PORT, () => {
    console.log(`Sports HQ server running on http://localhost:${PORT}`);
});