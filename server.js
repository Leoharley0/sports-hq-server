// server.js — TSDB-only, preseason-aware, sorted, returns n items (default 10)
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v7 (multi-soccer + status/isLive + robust live)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

// Polyfill
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ENV (Render → Environment)
const V2_KEY = process.env.TSDB_V2_KEY || ""; // required for v2 live
const V1_KEY = process.env.TSDB_V1_KEY || ""; // e.g. "123"
if (!V2_KEY) console.error("❌ Missing TSDB_V2_KEY");
if (!V1_KEY) console.warn("⚠️ Missing TSDB_V1_KEY");

const DEFAULT_COUNT = 10; // how many rows per board by default
const TTL = { LIVE:15e3, NEXT:5*60e3, SEASON:3*60*60e3, DAY:30*60e3, PAST:10*60e3, OUT:25e3, META:12*60*60e3 };

const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };

// Cache
const cache = new Map();
const getC = k => { const v = cache.get(k); if (v && v.exp>Date.now()) return v.val; if (v) cache.delete(k); return null; };
const setC = (k,val,ttl) => cache.set(k,{val,exp:Date.now()+ttl});

// Fetch helpers
async function fetchText(url, extra={}) {
  const res = await fetch(url, { headers: { ...COMMON_HEADERS, ...extra } });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} | ${txt.slice(0,180)}`);
  return txt;
}
async function fetchJson(url, extra={}) {
  return JSON.parse(await fetchText(url, extra));
}
async function memoJson(url, ttl, extra={}) {
  const k = `URL:${url}`;
  const hit = getC(k); if (hit) return hit;
  try { const j = await fetchJson(url, extra); if (j) setC(k,j,ttl); return j; }
  catch(e){ console.error("fetchJson error:", e.message, "→", url); return null; }
}

// Time / status / keys
function cleanTime(t){ if(!t) return "00:00:00"; const s=String(t).trim(); return (/^tba$|^tbd$/i.test(s))?"00:00:00":s; }
function toMillis(dateStr, timeStr){
  if(!dateStr) return NaN;
  const t = cleanTime(timeStr);
  const hasTZ = /[zZ]$|[+\-]\d\d:?\d\d$/.test(t);
  const ms = Date.parse(`${dateStr}T${t}${hasTZ?"":"Z"}`); // UTC default
  return Number.isNaN(ms)?NaN:ms;
}
function eventMillis(m){
  let ms = toMillis(m.dateEvent, m.strTime); if (!Number.isNaN(ms)) return ms;
  ms = toMillis(m.dateEventLocal||m.dateEvent, m.strTimeLocal||m.strTime); if (!Number.isNaN(ms)) return ms;
  if (m.strTimestampMS) { const n=+m.strTimestampMS; if (!Number.isNaN(n)) return n; }
  if (m.strTimestamp)   { const n=+m.strTimestamp*1000; if (!Number.isNaN(n)) return n; }
  if (m.dateEvent)      { ms = toMillis(m.dateEvent, "00:00:00Z"); if (!Number.isNaN(ms)) return ms; }
  if (m.dateEventLocal) { ms = toMillis(m.dateEventLocal, "00:00:00Z"); if (!Number.isNaN(ms)) return ms; }
  return NaN;
}
function pickScore(v){ return (v===undefined||v===null||v===""||v==="N/A")?null:v; }
function isLiveWord(s=""){ const t=(s+"").toLowerCase(); return t.includes("live")||t.includes("in play")||/^q\d/.test(t)||t.includes("quarter")||t.includes("ot")||t.includes("overtime")||t.includes("half")||t==="ht" || t==="1h" || t==="2h"; }
function isFinalWord(s=""){ const t=(s+"").toLowerCase(); return t.includes("final")||t==="ft"||t.includes("full time"); }
// CHANGED: if it's live-looking, return LIVE even if scores are missing
function normalizeStatus(m,s1,s2){
  const raw=String(m.strStatus||m.strProgress||"").trim();
  if (isFinalWord(raw)) return "Final";
  if (isLiveWord(raw))  return "LIVE";
  if (!raw||raw==="NS"||raw.toLowerCase()==="scheduled"||raw.toLowerCase()==="preview") return "Scheduled";
  const hasScore=(s1!==null)||(s2!==null);
  return hasScore ? raw : "Scheduled";
}
const FINAL_KEEP_MS = 15*60*1000;
function isOldFinal(m){ const raw=m.strStatus||m.strProgress||""; if(!isFinalWord(raw)) return false; const t=eventMillis(m); if(Number.isNaN(t)) return false; return (Date.now()-t)>FINAL_KEEP_MS; }
function computedStatus(m){ const s1=pickScore(m.intHomeScore??m.intHomeGoals), s2=pickScore(m.intAwayScore??m.intAwayGoals); return normalizeStatus(m,s1,s2); }
function matchKey(m){ return m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`; }
function pushUnique(arr,m){ const k=matchKey(m); if(!arr.some(x=>matchKey(x)===k)) arr.push(m); }
function sortForDisplay(a,b){
  const sa=computedStatus(a), sb=computedStatus(b);
  const pa=(sa==="Final")?0:(sa==="LIVE")?1:2, pb=(sb==="Final")?0:(sb==="LIVE")?1:2;
  if (pa!==pb) return pa-pb;
  const ta=eventMillis(a), tb=eventMillis(b);
  const aBad=!isFinite(ta), bBad=!isFinite(tb);
  if (aBad && !bBad) return +1;
  if (!aBad && bBad) return -1;
  if (pa===0) return tb-ta; // Finals newest first
  return ta-tb;            // Live/Scheduled soonest first
}

// Preseason-aware league match
function leagueMatch(m, leagueId, sport){
  const idOk = String(m.idLeague||"")===String(leagueId);
  const name = String(m.strLeague||"").toLowerCase();

  if (sport==="american_football") return idOk || name.includes("nfl");
  if (sport==="basketball")        return idOk; // NBA only (leagueId 4387)
  if (sport==="ice_hockey")        return idOk || name.includes("nhl");
  return idOk; // soccer: used when we call per-league; multi-league handled separately
}

// Fetchers (memoized)
async function v2Livescore(sport){
  const s=sport.replace(/_/g," ");
  const urls=[
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out=[]; for (const u of urls){ const j=await memoJson(u, TTL.LIVE, {"X-API-KEY":V2_KEY}); if (j?.livescore?.length) out.push(...j.livescore); }
  return out;
}
async function v1NextLeague(id){ const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsnextleague.php?id=${id}`, TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`, TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventspastleague.php?id=${id}`, TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }
const SPORT_LABEL={ soccer:"Soccer", basketball:"Basketball", american_football:"American Football", ice_hockey:"Ice Hockey" };
async function v1EventsDay(sport, ymd){ const label=SPORT_LABEL[sport]||sport; const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`, TTL.DAY); return Array.isArray(j?.events)?j.events:[]; }

// Seasons
function guessSeasonCrossYear(){ const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1, s=(m>=7)?y:y-1; return `${s}-${s+1}`; }
function seasonCandidates(sport, leagueId){
  const d=new Date(), y=d.getUTCFullYear(), cross=guessSeasonCrossYear(), crossPrev=`${y-1}-${y}`, single=String(y), singlePrev=String(y-1);
  if (leagueId===4391||sport==="american_football") return [single, singlePrev, cross, crossPrev];
  if (leagueId===4387||leagueId===4380)             return [cross, crossPrev, single, singlePrev];
  if (leagueId===4328)                               return [cross, crossPrev];
  return [cross, single, crossPrev, singlePrev];
}

// Fill future by day until n
async function fillByDaysUntil(out, sport, leagueId, n, maxWeeks=6){
  if (out.length>=n) return;
  const keys=new Set(out.map(matchKey));
  const today=new Date();
  for (let w=0; w<maxWeeks && out.length<n; w++){
    for (let d=0; d<7 && out.length<n; d++){
      const dt=new Date(today.getTime()+(w*7+d)*86400000);
      const ymd=dt.toISOString().slice(0,10);
      const rows=await v1EventsDay(sport, ymd);
      for (const m of rows){
        if (out.length>=n) break;
        if (!leagueMatch(m, leagueId, sport)) continue;
        const ms=eventMillis(m); if (isFinite(ms)&&ms<Date.now()) continue;
        const k=matchKey(m); if (keys.has(k)) continue;
        keys.add(k); out.push(m);
      }
    }
    console.log(`[day v1 fill week ${w}] ${sport} -> ${out.length}/${n}`);
  }
}

// Build list for one league
async function getLeagueMatchesCore(sport, leagueId, n){
  const out=[];

  // 1) LIVE
  const live=await v2Livescore(sport);
  for (const m of live||[]){ if (!leagueMatch(m, leagueId, sport)) continue; if (isOldFinal(m)) continue; pushUnique(out,m); }
  console.log(`[live] ${sport}/${leagueId} -> ${out.length}`);

  // 2) NEXT
  if (out.length<n){
    const e=await v1NextLeague(leagueId);
    e.sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of e){ if (out.length>=n) break; if (!leagueMatch(m, leagueId, sport)) continue; pushUnique(out,m); }
    console.log(`[next v1] ${sport}/${leagueId} -> ${out.length}/${n}`);
  }

  // 3) SEASON (future only)
  if (out.length<n){
    for (const s of seasonCandidates(sport, leagueId)){
      const e=await v1Season(leagueId,s);
      const now=Date.now();
      const fut=e.filter(x=>leagueMatch(x,leagueId,sport) && isFinite(eventMillis(x)) && eventMillis(x)>=now)
                 .sort((a,b)=>eventMillis(a)-eventMillis(b));
      for (const m of fut){ if (out.length>=n) break; pushUnique(out,m); }
      console.log(`[season ${s}] ${sport}/${leagueId} -> ${out.length}/${n}`);
      if (out.length>=n) break;
    }
  }

  // 4) DAY scan
  await fillByDaysUntil(out, sport, leagueId, n, 6);

  // 5) PAST (recent finals ≤15m)
  if (out.length<n){
    const e=await v1PastLeague(leagueId);
    e.sort((a,b)=>eventMillis(b)-eventMillis(a));
    for (const m of e){ if (out.length>=n) break; if (!leagueMatch(m,leagueId,sport)) continue; m.strStatus=m.strStatus||"Final"; if (isOldFinal(m)) continue; pushUnique(out,m); }
    console.log(`[past recent] ${sport}/${leagueId} -> ${out.length}/${n}`);
  }

  // Sort for display
  out.sort(sortForDisplay);
  return out.slice(0,n);
}

// Cache final response by n too
async function getLeagueMatchesCached(sport, leagueId, n){
  const key=`OUT:${sport}:${leagueId}:${n}`;
  const hit=getC(key); if (hit) return hit;
  const data=await getLeagueMatchesCore(sport, leagueId, n);
  setC(key, data, TTL.OUT + Math.floor(Math.random()*5000));
  return data;
}

// --- NEW: resolve soccer league IDs by league names (once, cached) ---
const BIG_SOCCER_NAMES = [
  "English Premier League",
  "Spanish La Liga",
  "Italian Serie A",
  "German Bundesliga",
  "French Ligue 1",
  "Dutch Eredivisie",
  "Portuguese Primeira Liga",
  "Major League Soccer"
];
async function resolveSoccerLeagueIdsByName(names=BIG_SOCCER_NAMES){
  const k="META:SOCCER:LEAGUE_IDS";
  const hit = getC(k); if (hit) return hit;
  const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/search_all_leagues.php?s=Soccer`, TTL.META);
  const arr = Array.isArray(j?.countrys)? j.countrys : [];
  const want = new Set(names.map(s=>s.toLowerCase()));
  const ids = [];
  for (const row of arr){
    const name=(row.strLeague||"").toLowerCase();
    if (want.has(name)) ids.push(parseInt(row.idLeague,10));
  }
  console.log("[meta] soccer big-league ids:", ids.join(", "));
  setC(k, ids, TTL.META);
  return ids;
}

// --- NEW: aggregate many soccer leagues and return top n ---
async function getSoccerBigLeagues(n){
  const ids = await resolveSoccerLeagueIdsByName();
  const merged = [];
  for (const id of ids){
    const items = await getLeagueMatchesCached("soccer", id, n);
    for (const m of items) pushUnique(merged, m);
  }
  merged.sort(sortForDisplay);
  return merged.slice(0, n);
}

// Format output (now includes league, status, isLive)
function formatMatch(m){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"";
  const away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=pickScore(m.intHomeScore??m.intHomeGoals);
  const s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const status=computedStatus(m);
  const ms=eventMillis(m);
  return {
    league: m.strLeague || "",
    team1: home, team2: away,
    score1: s1===null?"N/A":String(s1),
    score2: s2===null?"N/A":String(s2),
    status, isLive: status==="LIVE",
    headline: `${home} vs ${away} - ${status}`,
    start: isFinite(ms)?new Date(ms).toISOString():null
  };
}

// Endpoints
const CONFIGS = {
  // soccer is now MULTI-league; nba/nfl/nhl unchanged
  "/scores/nba":    { sport:"basketball",        leagueId:4387 },
  "/scores/nfl":    { sport:"american_football", leagueId:4391 },
  "/scores/nhl":    { sport:"ice_hockey",        leagueId:4380 },
};

// Multi-league soccer endpoint
app.get("/scores/soccer", async (req,res)=>{
  try{
    const n = Math.max(5, Math.min(20, parseInt(req.query.n || DEFAULT_COUNT, 10) || DEFAULT_COUNT));
    const items = await getSoccerBigLeagues(n);
    console.log(`/scores/soccer → ${items.length} items (n=${n})`);
    res.json(items.map(formatMatch));
  }catch(e){ console.error("/scores/soccer handler error:",e); res.status(500).json({error:"internal"}); }
});

// Single-league endpoints as before
for (const [path,cfg] of Object.entries(CONFIGS)){
  app.get(path, async (req,res)=>{
    try{
      const n = Math.max(5, Math.min(20, parseInt(req.query.n || DEFAULT_COUNT, 10) || DEFAULT_COUNT));
      const items = await getLeagueMatchesCached(cfg.sport, cfg.leagueId, n);
      console.log(`${path} → ${items.length} items (n=${n})`);
      res.json(items.map(formatMatch));
    }catch(e){ console.error(path,"handler error:",e); res.status(500).json({error:"internal"}); }
  });
}

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
