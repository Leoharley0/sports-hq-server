// server.js — v18: MLB+NBA+NFL+NHL guaranteed 10 rows (Finals→Live→Scheduled)
// Low-load with SWR caching + retry, no dependency on v2 live to fill lists.

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v18 (4-leagues, guaranteed 10 rows, SWR cache)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

// Polyfill fetch for Node < 18
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ====== ENV / KEYS ==========================================================
const V2_KEY = process.env.TSDB_V2_KEY || "";             // optional
const V1_KEY = process.env.TSDB_V1_KEY || "3";            // always usable fallback

// ====== CONSTANTS / TTLs ====================================================
const DEFAULT_COUNT = 10;

const TTL = {
  LIVE:   15_000,         // v2 livescore
  NEXT:    5 * 60_000,    // v1 next
  SEASON:  3 * 60 * 60_000,// v1 season
  DAY:    30 * 60_000,    // v1 day
  PAST:   10 * 60_000,    // v1 past (recent finals)
  OUT:     60_000,        // built board
};
const SWR_EXTRA = 5 * 60_000;

// throttle for day scan (keeps warm after first fill)
let DAY_TOKENS = 120;
setInterval(() => { DAY_TOKENS = Math.min(120, DAY_TOKENS + 6); }, 10_000);

// ====== CACHES ==============================================================
const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
const cache = new Map();    // key -> {val, exp, swr}
const inflight = new Map(); // key -> Promise

function getCache(key){
  const e = cache.get(key); if (!e) return {hit:false};
  const now = Date.now();
  if (now <= e.exp) return {hit:true, fresh:true,  val:e.val};
  if (now <= e.swr) return {hit:true, fresh:false, val:e.val};
  return {hit:false};
}
function setCache(key, val, ttl){
  const now = Date.now();
  cache.set(key, { val, exp: now + ttl, swr: now + ttl + SWR_EXTRA });
}
async function withInflight(key, fn){
  if (inflight.has(key)) return inflight.get(key);
  const p = (async()=>{ try{ return await fn(); } finally{ inflight.delete(key); } })();
  inflight.set(key,p); return p;
}

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const jitter = ms => ms + Math.floor(Math.random()*(ms/3));

async function fetchJsonRetry(url, extra={}, tries=4, baseDelay=700){
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
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} | ${txt.slice(0,160)}`);
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
  const c = getCache(key);
  if (c.hit && c.fresh) return c.val;

  const fetcher = async ()=>{
    const j = await fetchJsonRetry(url, extra);
    if (j) setCache(key, j, ttl);
    return j || c.val || null;
  };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ====== TIME / STATUS HELPERS ==============================================
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
function isLiveWord(s=""){ s=(s+"").toLowerCase(); return s.includes("live")||s.includes("in play")||s.includes("half")||s.includes("inning")||s==="ht"||s.includes("ot"); }
function isFinalWord(s=""){ s=(s+"").toLowerCase(); return s.includes("final")||s.includes("full time")||s==="ft"; }
function normalizeStatus(m,s1,s2){
  const raw=String(m.strStatus||m.strProgress||"").trim(), has=(s1!==null)||(s2!==null);
  if (isFinalWord(raw)) return "Final";
  if (isLiveWord(raw))  return has ? "LIVE" : "Scheduled";
  if (!raw||raw==="NS"||raw.toLowerCase()==="scheduled"||raw.toLowerCase()==="preview") return "Scheduled";
  return has ? raw : "Scheduled";
}
const FINAL_KEEP_MS = 15*60*1000;
function isRecentFinal(m){
  const raw=m.strStatus||m.strProgress||""; if (!isFinalWord(raw)) return false;
  const ms=eventMillis(m); if (!isFinite(ms)) return false;
  return (Date.now()-ms) <= FINAL_KEEP_MS;
}
function computedStatus(m){
  const s1=pickScore(m.intHomeScore??m.intHomeGoals), s2=pickScore(m.intAwayScore??m.intAwayGoals);
  return normalizeStatus(m,s1,s2);
}
function matchKey(m){ return m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`; }
function pushUnique(arr,m){ const k=matchKey(m); if(!arr.some(x=>matchKey(x)===k)) arr.push(m); }
function sortForDisplay(a,b){
  const rank = s => s==="Final"?0 : s==="LIVE"?1 : 2;
  const sa=computedStatus(a), sb=computedStatus(b);
  if (rank(sa)!==rank(sb)) return rank(sa)-rank(sb);
  const ta=eventMillis(a), tb=eventMillis(b);
  const aBad=!isFinite(ta), bBad=!isFinite(tb);
  if (aBad && !bBad) return +1;
  if (!aBad && bBad) return -1;
  if (sa==="Final") return tb-ta; // newest finals
  return ta-tb;                   // soonest first
}

// ====== UPSTREAM WRAPPERS (v1 + v2) ========================================
const V1 = (p)=>`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/${p}`;
const SPORT_LABEL={ baseball:"Baseball", basketball:"Basketball", american_football:"American Football", ice_hockey:"Ice Hockey" };

async function v1NextLeague(id){ const j=await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(V1(`eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`), TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }
async function v1EventsDay(sport, ymd){
  const label=SPORT_LABEL[sport]||sport;
  const j=await memoJson(V1(`eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`), TTL.DAY);
  return Array.isArray(j?.events)?j.events:[]; }

// Optional live (not required to fill)
async function v2Livescore(sport){
  const s=sport.replace(/_/g," ");
  const urls=[
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out=[]; for (const u of urls){
    const j = await memoJson(u, TTL.LIVE, V2_KEY ? {"X-API-KEY":V2_KEY} : {});
    if (j?.livescore?.length) out.push(...j.livescore);
  }
  return out;
}

// ====== SEASON HELPERS ======================================================
function guessSeasonCrossYear(){ const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1; const start=(m>=7)?y:y-1; return `${start}-${start+1}`; }
function seasonsCrossTriple(){ const c=guessSeasonCrossYear(); return [c, `${parseInt(c)-1}-${parseInt(c)}`, `${parseInt(c)+1}-${parseInt(c)+2}`]; }
function seasonsSingle2(){ const y=(new Date()).getUTCFullYear(); return [String(y), String(y+1)]; } // MLB/NFL useful single-year ids

// ====== LEAGUE IDS ==========================================================
const L = {
  MLB: 4424,              // Major League Baseball
  NBA: 4387,
  NFL: 4391,
  NHL: 4380,
};

// ====== BUILDERS ============================================================
async function fillFromSeasons(out, leagueId, seasons, n){
  const now=Date.now();
  for (const s of seasons){
    const rows=await v1Season(leagueId, s);
    const fut=(rows||[]).filter(m=>{const ms=eventMillis(m);return isFinite(ms)&&ms>=now;})
                        .sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of fut){ if (out.length>=n) break; pushUnique(out,m); }
    if (out.length>=n) break;
  }
}

async function dayFill(sport, filterLeagueId, out, n, maxDays=28){
  let short = n - out.length; if (short<=0) return;
  if (DAY_TOKENS <= 0) return;

  const today = new Date();
  for (let d=0; d<maxDays && DAY_TOKENS>0 && out.length<n; d++){
    const ymd = new Date(today.getTime()+d*86400000).toISOString().slice(0,10);
    const rows = await v1EventsDay(sport, ymd); DAY_TOKENS--;
    const now=Date.now();
    const fut = (rows||[])
      .filter(m => !filterLeagueId || String(m.idLeague||"")===String(filterLeagueId))
      .filter(m => { const ms=eventMillis(m); return isFinite(ms)&&ms>=now; })
      .sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of fut){ if (out.length>=n) break; pushUnique(out,m); }
  }
}

async function buildSingle({ sport, leagueId, seasons, n }){
  const finals=[], live=[], sched=[];
  const now = Date.now();

  // Finals (≤15m)
  const past = await v1PastLeague(leagueId);
  for (const m of (past||[])) if (isRecentFinal(m)) pushUnique(finals, m);
  finals.sort((a,b)=>eventMillis(b)-eventMillis(a));

  // Live (optional)
  const ls = await v2Livescore(sport);
  for (const m of (ls||[])) if (String(m.idLeague||"")===String(leagueId) && !isRecentFinal(m)) pushUnique(live, m);

  // Next (cheap)
  const next = await v1NextLeague(leagueId);
  next.sort((a,b)=>eventMillis(a)-eventMillis(b));
  for (const m of next){ if (finals.length+live.length+sched.length>=n) break;
    const ms=eventMillis(m); if (!isFinite(ms)||ms<now) continue; pushUnique(sched,m); }

  // Season future
  if (finals.length+live.length+sched.length < n){
    await fillFromSeasons(sched, leagueId, seasons, n - (finals.length+live.length));
  }

  // Day scan as last resort
  if (finals.length+live.length+sched.length < n){
    await dayFill(sport, leagueId, sched, n - (finals.length+live.length), 35);
  }

  const merged = [...finals, ...live, ...sched].sort(sortForDisplay).slice(0, n);
  return merged;
}

// ====== OUTPUT CACHE WRAPPER ===============================================
async function getBoardCached(key, builder){
  const c=getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const data=await builder(); setCache(key,data,TTL.OUT); return data; };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ====== ROUTES ==============================================================
// MLB replaces the previous soccer board
app.get("/scores/baseball", async (req,res)=>serveSingle(req,res,"baseball",        L.MLB, seasonsSingle2()));
app.get("/scores/nba",      async (req,res)=>serveSingle(req,res,"basketball",      L.NBA, seasonsCrossTriple()));
app.get("/scores/nfl",      async (req,res)=>serveSingle(req,res,"american_football",L.NFL, seasonsSingle2()));
app.get("/scores/nhl",      async (req,res)=>serveSingle(req,res,"ice_hockey",      L.NHL, seasonsCrossTriple()));

async function serveSingle(req,res,sport,leagueId,seasons){
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const key = `OUT:${sport}:${leagueId}:${n}`;
    const items = await getBoardCached(key, () => buildSingle({ sport, leagueId, seasons, n }));
    console.log(`/${req.path.split("/").pop()} -> ${items.length} items (n=${n})`);
    res.json(items.map(formatMatch));
  }catch(e){ console.error(`${sport} error:`, e); res.status(500).json({error:"internal"}); }
}

// Format row for Roblox
function formatMatch(m){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"";
  const away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=pickScore(m.intHomeScore??m.intHomeGoals);
  const s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const status=normalizeStatus(m,s1,s2);
  const ms=eventMillis(m);
  return {
    team1:home, team2:away,
    score1:s1===null?"N/A":String(s1),
    score2:s2===null?"N/A":String(s2),
    headline:`${home} vs ${away} - ${status}`,
    start:isFinite(ms)?new Date(ms).toISOString():null
  };
}

// Debug endpoints (optional)
app.get("/_debug/:board", async (req,res)=>{
  const b=req.params.board;
  const map={ nba:[L.NBA,"basketball",seasonsCrossTriple()],
              nfl:[L.NFL,"american_football",seasonsSingle2()],
              nhl:[L.NHL,"ice_hockey",seasonsCrossTriple()],
              baseball:[L.MLB,"baseball",seasonsSingle2()]};
  const cfg = map[b]; if(!cfg) return res.status(400).json({error:"bad board"});
  const [leagueId, sport, seasons] = cfg;
  // just show what upstreams return counts-wise
  const finals = (await v1PastLeague(leagueId))||[];
  const live   = (await v2Livescore(sport))||[];
  const next   = (await v1NextLeague(leagueId))||[];
  res.json({ board:b, leagueId, counts:{
    past_all: finals.length,
    live_allSports: live.length,
    next_all: next.length
  }, note:"diagnostic counts only" });
});

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
