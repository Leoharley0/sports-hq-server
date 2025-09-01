// server.js — vMLB-Swap
// Replace “soccer” with MLB. Order logic: Recent Finals (≤15m) → Live → Scheduled (soonest).
// Light on requests, cached, resilient to 429s.

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ vMLB-Swap (MLB board + NBA/NFL/NHL)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

// Polyfill fetch for Node < 18
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ===== KEYS =====
const V2_KEY = process.env.TSDB_V2_KEY || ""; // v2 livescore header
const V1_KEY = process.env.TSDB_V1_KEY || ""; // v1 path key (falls back to public "3")
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY missing (live may be limited)");
if (!V1_KEY) console.warn("ℹ️ TSDB_V1_KEY missing; using shared/test key");

// ===== CONSTANTS =====
const DEFAULT_COUNT = 10;

const TTL = { LIVE: 15_000, NEXT: 5 * 60_000, PAST: 5 * 60_000, OUT: 35_000 };
const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = ms => ms + Math.floor(Math.random() * (ms/3));

// MLB league id on TheSportsDB is 4424 (visible in their season URL like /season/4424-MLB/2025)
const L = {
  MLB: 4424,
  NBA: 4387,
  NFL: 4391,
  NHL: 4380,
};

// ===== tiny cache (SWR-ish) =====
const cache = new Map();    // key -> { val, exp }
function getC(k){ const e=cache.get(k); if (!e) return null; if (Date.now()<e.exp) return e.val; cache.delete(k); return null; }
function setC(k,v,ttl){ cache.set(k,{val:v,exp:Date.now()+ttl}); }

// ===== fetch helpers with retry/429 backoff =====
async function fetchJsonRetry(url, extra={}, tries=4, baseDelay=650){
  let lastErr;
  for (let i=0;i<tries;i++){
    try{
      const res = await fetch(url, { headers: { ...COMMON_HEADERS, ...extra } });
      const txt = await res.text();
      if (res.status === 429){
        const ra = Number(res.headers?.get("retry-after")) || 0;
        const wait = jitter(ra ? ra*1000 : baseDelay*Math.pow(2,i));
        console.warn(`[429] wait ${wait}ms :: ${url}`);
        await sleep(wait); continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} | ${txt.slice(0,200)}`);
      return JSON.parse(txt);
    }catch(e){
      lastErr = e;
      const wait = jitter(baseDelay*Math.pow(2,i));
      console.warn(`[retry] ${e.message}; wait ${wait}ms :: ${url}`);
      await sleep(wait);
    }
  }
  console.error(`[FAIL] ${lastErr?.message} :: ${url}`);
  return null;
}
async function memoJson(url, ttl, extra={}){
  const key = `URL:${url}`;
  const hit = getC(key);
  if (hit) return hit;
  const data = await fetchJsonRetry(url, extra);
  if (data) setC(key, data, ttl);
  return data;
}

// ===== time & status helpers =====
function cleanTime(t){ if(!t) return "00:00:00"; const s=String(t).trim(); return (/^tba$|^tbd$/i.test(s))?"00:00:00":s; }
function toMillis(d,t){ if(!d) return NaN; const tt=cleanTime(t); const hasTZ=/[zZ]$|[+\-]\d\d:?\d\d$/.test(tt); const ms=Date.parse(`${d}T${tt}${hasTZ?"":"Z"}`); return Number.isNaN(ms)?NaN:ms; }
function eventMillis(m){
  let ms = toMillis(m.dateEvent, m.strTime); if (!Number.isNaN(ms)) return ms;
  ms = toMillis(m.dateEventLocal||m.dateEvent, m.strTimeLocal||m.strTime); if (!Number.isNaN(ms)) return ms;
  if (m.strTimestampMS){ const n=+m.strTimestampMS; if (!Number.isNaN(n)) return n; }
  if (m.strTimestamp){ const n=+m.strTimestamp*1000; if (!Number.isNaN(n)) return n; }
  if (m.dateEvent){ ms=toMillis(m.dateEvent,"00:00:00Z"); if (!Number.isNaN(ms)) return ms; }
  if (m.dateEventLocal){ ms=toMillis(m.dateEventLocal,"00:00:00Z"); if (!Number.isNaN(ms)) return ms; }
  return NaN;
}
function pickScore(v){ return (v===undefined||v===null||v===""||v==="N/A")?null:v; }
function isLiveWord(s=""){ s=(s+"").toLowerCase(); return s.includes("live")||s.includes("in play")||s.includes("quarter")||s.includes("half")||s.includes("ot")||/^q\d/.test(s) || s.includes("top") || s.includes("bot") || s.includes("inning"); }
function isFinalWord(s=""){ s=(s+"").toLowerCase(); return s.includes("final")||s==="ft"||s.includes("full time"); }
const FINAL_KEEP_MS = 15*60*1000;
function isRecentFinal(m){ const raw=m.strStatus||m.strProgress||""; if(!isFinalWord(raw)) return false; const ms=eventMillis(m); if(!isFinite(ms)) return false; return (Date.now()-ms)<=FINAL_KEEP_MS; }
function normalizeStatus(m){
  const raw=String(m.strStatus||m.strProgress||"").trim();
  const s1=pickScore(m.intHomeScore??m.intHomeGoals??m.intHomeRuns);
  const s2=pickScore(m.intAwayScore??m.intAwayGoals??m.intAwayRuns);
  const has=(s1!==null)||(s2!==null);
  if (isFinalWord(raw)) return "Final";
  if (isLiveWord(raw))  return has ? "LIVE" : "Scheduled";
  if (!raw||raw==="NS"||raw.toLowerCase()==="scheduled"||raw.toLowerCase()==="preview") return "Scheduled";
  return has ? raw : "Scheduled";
}
function matchKey(m){ return m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`; }
function pushUnique(arr,m){ const k=matchKey(m); if(!arr.some(x=>matchKey(x)===k)) arr.push(m); }
function sortForDisplay(a,b){
  const rank = s => s==="Final"?0 : s==="LIVE"?1 : 2;
  const sa=normalizeStatus(a), sb=normalizeStatus(b);
  if (rank(sa)!==rank(sb)) return rank(sa)-rank(sb);
  const ta=eventMillis(a), tb=eventMillis(b);
  const aBad=!isFinite(ta), bBad=!isFinite(tb);
  if (aBad && !bBad) return +1;
  if (!aBad && bBad) return -1;
  if (sa==="Final") return tb-ta; // newest finals first
  return ta-tb;                   // soonest first
}

// ===== TSDB wrappers =====
const V1 = (p)=>`https://www.thesportsdb.com/api/v1/json/${V1_KEY || "3"}/${p}`;
async function v1NextLeague(id){ const j=await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }
async function v2Livescore(sport){
  const s=sport.replace(/_/g," ");
  const urls=[
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out=[];
  for (const u of urls){
    const j = await memoJson(u, TTL.LIVE, V2_KEY ? {"X-API-KEY":V2_KEY} : {});
    if (j?.livescore?.length) out.push(...j.livescore);
  }
  return out;
}

// ===== build (generic single-league) =====
async function buildSingle({ sport, leagueId, n }){
  const finals=[], live=[], sched=[];
  const now = Date.now();

  // 1) recent finals
  for (const m of (await v1PastLeague(leagueId))){
    if (isRecentFinal(m)) pushUnique(finals, m);
  }

  // 2) live
  for (const m of (await v2Livescore(sport))){
    if (String(m.idLeague||"")===String(leagueId) && !isRecentFinal(m)) pushUnique(live, m);
  }

  // 3) scheduled (cheap next-league first)
  const next = (await v1NextLeague(leagueId)).sort((a,b)=>eventMillis(a)-eventMillis(b));
  for (const m of next){
    if (sched.length + live.length + finals.length >= n) break;
    const ms=eventMillis(m); if (!isFinite(ms) || ms<now) continue;
    pushUnique(sched, m);
  }

  // Final sort + trim
  const out = [...finals, ...live, ...sched].sort(sortForDisplay).slice(0,n);
  return out;
}

// ===== cached wrappers =====
async function getBoardCached(key, builder){
  const hit=getC(key); if (hit) return hit;
  const data=await builder();
  setC(key,data,TTL.OUT);
  return data;
}

// ===== format to client =====
function formatMatch(m){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"";
  const away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=pickScore(m.intHomeScore??m.intHomeGoals??m.intHomeRuns);
  const s2=pickScore(m.intAwayScore??m.intAwayGoals??m.intAwayRuns);
  const ms=eventMillis(m);
  const status=normalizeStatus(m);
  return {
    team1: home, team2: away,
    score1: s1===null?"N/A":String(s1),
    score2: s2===null?"N/A":String(s2),
    headline: `${home} vs ${away} - ${status}`,
    start: isFinite(ms)?new Date(ms).toISOString():null
  };
}

// ===== routes =====
// MLB replaces soccer screen:
app.get("/scores/baseball", async (req,res)=>{
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const items = await getBoardCached(`OUT:baseball:${L.MLB}:${n}`, ()=>buildSingle({ sport:"baseball", leagueId:L.MLB, n }));
    console.log(`/scores/baseball → ${items.length} (n=${n})`);
    res.json(items.map(formatMatch));
  }catch(e){ console.error("baseball error:", e); res.status(500).json({error:"internal"}); }
});

app.get("/scores/nba", async (req,res)=>{
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const items = await getBoardCached(`OUT:nba:${L.NBA}:${n}`, ()=>buildSingle({ sport:"basketball", leagueId:L.NBA, n }));
    console.log(`/scores/nba → ${items.length} (n=${n})`);
    res.json(items.map(formatMatch));
  }catch(e){ console.error("nba error:", e); res.status(500).json({error:"internal"}); }
});

app.get("/scores/nfl", async (req,res)=>{
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const items = await getBoardCached(`OUT:nfl:${L.NFL}:${n}`, ()=>buildSingle({ sport:"american_football", leagueId:L.NFL, n }));
    console.log(`/scores/nfl → ${items.length} (n=${n})`);
    res.json(items.map(formatMatch));
  }catch(e){ console.error("nfl error:", e); res.status(500).json({error:"internal"}); }
});

app.get("/scores/nhl", async (req,res)=>{
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const items = await getBoardCached(`OUT:nhl:${L.NHL}:${n}`, ()=>buildSingle({ sport:"ice_hockey", leagueId:L.NHL, n }));
    console.log(`/scores/nhl → ${items.length} (n=${n})`);
    res.json(items.map(formatMatch));
  }catch(e){ console.error("nhl error:", e); res.status(500).json({error:"internal"}); }
});

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
