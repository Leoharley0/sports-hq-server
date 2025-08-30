// server.js — v12: low-stress (10 rows), EPL-only soccer, SWR cache + 429 backoff
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v12 (10 rows + EPL-only)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

// Polyfill fetch for Node < 18
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ===== ENV KEYS =====
const V2_KEY = process.env.TSDB_V2_KEY || "";
const V1_KEY = process.env.TSDB_V1_KEY || ""; // if blank we fall back to the shared test key
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY missing; live coverage may be limited");
if (!V1_KEY) console.warn("ℹ️ TSDB_V1_KEY missing; using shared/test key behaviour");

// ===== CONFIG (10 rows everywhere) =====
const DEFAULT_COUNT = 10;

const TTL = {
  LIVE:   15_000,          // v2 livescore cache
  NEXT:   5 * 60_000,      // v1 next-league
  SEASON: 2 * 60 * 60_000, // v1 season
  DAY:    30 * 60_000,     // v1 eventsday
  PAST:   10 * 60_000,     // v1 past-league
  OUT:    60_000,          // final merged list
};
const SWR_EXTRA = 5 * 60_000; // serve stale while revalidating for 5m

// Tiny global token bucket for “day” scans so we never spam v1
const DAY_TOKENS_MAX = 6;
const DAY_TOKENS_REFILL_MS = 15_000;
let DAY_TOKENS = DAY_TOKENS_MAX;
setInterval(() => { DAY_TOKENS = Math.min(DAY_TOKENS_MAX, DAY_TOKENS + 1); }, DAY_TOKENS_REFILL_MS);

const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const jitter = ms => ms + Math.floor(Math.random() * (ms/3));

// ===== SWR cache + in-flight dedupe =====
const cache    = new Map(); // key -> { val, exp, swr }
const inflight = new Map(); // key -> Promise

function getCache(key) {
  const ent = cache.get(key);
  if (!ent) return { hit:false };
  const now = Date.now();
  if (now <= ent.exp) return { hit:true, fresh:true,  val:ent.val };
  if (now <= ent.swr) return { hit:true, fresh:false, val:ent.val };
  return { hit:false };
}
function setCache(key, val, ttl) {
  const now = Date.now();
  cache.set(key, { val, exp: now + ttl, swr: now + ttl + SWR_EXTRA });
}
async function withInflight(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async()=>{ try { return await fn(); } finally { inflight.delete(key); } })();
  inflight.set(key, p);
  return p;
}

// ===== fetch with backoff =====
async function fetchJsonRetry(url, extra={}, tries=4, baseDelay=600) {
  let lastErr;
  for (let i=0;i<tries;i++) {
    try {
      const res = await fetch(url, { headers: { ...COMMON_HEADERS, ...extra } });
      const txt = await res.text();
      if (res.status === 429) {
        const ra = Number(res.headers?.get("retry-after")) || 0;
        const wait = jitter(ra ? ra*1000 : baseDelay * Math.pow(2,i));
        console.warn(`[429] wait ${wait}ms :: ${url}`);
        await sleep(wait); continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} | ${txt.slice(0,160)}`);
      return JSON.parse(txt);
    } catch (e) {
      lastErr = e;
      const wait = jitter(baseDelay * Math.pow(2,i));
      console.warn(`[retry] ${e.message}; wait ${wait}ms :: ${url}`);
      await sleep(wait);
    }
  }
  console.error(`[FAIL] ${lastErr?.message} :: ${url}`);
  return null;
}
async function memoJson(url, ttl, extra={}) {
  const key = `URL:${url}`;
  const c = getCache(key);
  if (c.hit && c.fresh) return c.val;

  const fetcher = async () => {
    const j = await fetchJsonRetry(url, extra);
    if (j) setCache(key, j, ttl);
    return j || c.val || null;
  };

  if (c.hit && !c.fresh) { withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ===== time / status helpers =====
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
function isLiveWord(s=""){ s=(s+"").toLowerCase(); return s.includes("live")||s.includes("in play")||s.includes("half")||s==="ht"||s.includes("ot"); }
function isFinalWord(s=""){ s=(s+"").toLowerCase(); return s.includes("final")||s==="ft"||s.includes("full time"); }
function normalizeStatus(m,s1,s2){
  const raw=String(m.strStatus||m.strProgress||"").trim(), hasScore=(s1!==null)||(s2!==null);
  if (isFinalWord(raw)) return "Final";
  if (isLiveWord(raw))  return hasScore ? "LIVE" : "Scheduled";
  if (!raw||raw==="NS"||raw.toLowerCase()==="scheduled"||raw.toLowerCase()==="preview") return "Scheduled";
  return hasScore ? raw : "Scheduled";
}
const FINAL_KEEP_MS = 15*60*1000;
function isOldFinal(m){ const t=eventMillis(m); if(Number.isNaN(t)) return false; const raw=m.strStatus||m.strProgress||""; return isFinalWord(raw) && (Date.now()-t)>FINAL_KEEP_MS; }
function computedStatus(m){ const s1=pickScore(m.intHomeScore??m.intHomeGoals), s2=pickScore(m.intAwayScore??m.intAwayGoals); return normalizeStatus(m,s1,s2); }
function matchKey(m){ return m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`; }
function pushUnique(arr,m){ const k=matchKey(m); if(!arr.some(x=>matchKey(x)===k)) arr.push(m); }
function sortForDisplay(a,b){
  const sa=computedStatus(a), sb=computedStatus(b);
  const pa=(sa==="Final")?0:(sa==="LIVE")?1:2, pb=(sb==="Final")?0:(sb==="LIVE")?1:2;
  if (pa!==pb) return pa-pb;
  const ta=eventMillis(a), tb=eventMillis(b);
  const aBad=!isFinite(ta), bBad=!isFinite(tb);
  if (aBad && !bBad) return +1; if (!aBad && bBad) return -1;
  if (pa===0) return tb-ta; // newest finals first
  return ta-tb;            // soonest live/scheduled first
}

// ===== TSDB wrappers =====
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
const V1 = (path) => `https://www.thesportsdb.com/api/v1/json/${V1_KEY || "3"}/${path}`;
async function v1NextLeague(id){ const j=await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(V1(`eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`), TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }
const SPORT_LABEL={ soccer:"Soccer", basketball:"Basketball", american_football:"American Football", ice_hockey:"Ice Hockey" };
async function v1EventsDay(sport, ymd){
  if (DAY_TOKENS <= 0) { console.warn(`[DAY throttle] skip ${sport} ${ymd}`); return []; }
  DAY_TOKENS--;
  const label=SPORT_LABEL[sport]||sport;
  const j=await memoJson(V1(`eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`), TTL.DAY);
  return Array.isArray(j?.events)?j.events:[];
}

// ===== seasons =====
function guessSeasonCrossYear(){ const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1, s=(m>=7)?y:y-1; return `${s}-${s+1}`; }
function seasonCandidatesEPL(){ const cross=guessSeasonCrossYear(); const prev = cross.split("-")[0]-1; return [cross, `${prev}-${prev+1}`]; }

// ===== format out =====
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

// ===== builders =====
const EPL = 4328; // soccer only

async function buildSoccerEPL(n){
  const out=[];

  // LIVE once
  const live = await v2Livescore("soccer");
  for (const m of live||[]){
    if (String(m.idLeague||"")===String(EPL) && !isOldFinal(m)) pushUnique(out,m);
  }

  // NEXT (usually enough)
  if (out.length < n){
    const next = (await v1NextLeague(EPL))
      .filter(m => { const ms=eventMillis(m); return isFinite(ms) && ms>=Date.now(); })
      .sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of next){ if (out.length>=n) break; pushUnique(out,m); }
  }

  // If still short, hit current-season once
  if (out.length < n){
    const seasons = seasonCandidatesEPL();
    for (const s of seasons){
      const sea = (await v1Season(EPL, s))
        .filter(m => { const ms=eventMillis(m); return isFinite(ms) && ms>=Date.now(); })
        .sort((a,b)=>eventMillis(a)-eventMillis(b));
      for (const m of sea){ if (out.length>=n) break; pushUnique(out,m); }
      if (out.length>=n) break;
    }
  }

  // Gentle day fill (2 weeks max, token-limited)
  if (out.length < n){
    const today=new Date();
    outer: for (let w=0; w<2; w++){
      for (let d=0; d<7; d++){
        const ymd=new Date(today.getTime()+(w*7+d)*86400000).toISOString().slice(0,10);
        const rows = await v1EventsDay("soccer", ymd);
        const fut  = rows.filter(m => String(m.idLeague||"")===String(EPL) && isFinite(eventMillis(m)) && eventMillis(m)>=Date.now())
                         .sort((a,b)=>eventMillis(a)-eventMillis(b));
        for (const m of fut){ if (out.length>=n) break outer; pushUnique(out,m); }
      }
    }
  }

  // Fresh recent finals to fill remaining slots
  if (out.length < n){
    const past = (await v1PastLeague(EPL)).sort((a,b)=>eventMillis(b)-eventMillis(a));
    for (const m of past){
      if (out.length>=n) break;
      m.strStatus = m.strStatus || "Final";
      if (!isOldFinal(m)) pushUnique(out,m);
    }
  }

  out.sort(sortForDisplay);
  return out.slice(0,n);
}

function leagueMatch(m, leagueId, sport){
  const idOk = String(m.idLeague||"")===String(leagueId);
  const name = String(m.strLeague||"").toLowerCase();
  if (sport==="american_football") return idOk || name.includes("nfl");
  if (sport==="basketball")        return idOk;
  if (sport==="ice_hockey")        return idOk || name.includes("nhl");
  return idOk;
}
async function buildSingle(sport, leagueId, n){
  const out=[];
  const live=await v2Livescore(sport);
  for (const m of live||[]) if (leagueMatch(m,leagueId,sport) && !isOldFinal(m)) pushUnique(out,m);

  if (out.length<n){
    const e=(await v1NextLeague(leagueId)).sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of e){ if (out.length>=n) break; if (leagueMatch(m,leagueId,sport)) pushUnique(out,m); }
  }

  // very light day fill (≤ 1 week)
  if (out.length<n){
    const today=new Date();
    outer: for (let d=0; d<7; d++){
      const ymd=new Date(today.getTime()+d*86400000).toISOString().slice(0,10);
      const rows=await v1EventsDay(sport, ymd);
      for (const m of rows||[]){
        if (out.length>=n) break outer;
        if (!leagueMatch(m,leagueId,sport)) continue;
        const ms=eventMillis(m); if (isFinite(ms) && ms<Date.now()) continue;
        pushUnique(out,m);
      }
    }
  }

  if (out.length<n){
    const p=(await v1PastLeague(leagueId)).sort((a,b)=>eventMillis(b)-eventMillis(a));
    for (const m of p){ if (out.length>=n) break; if (!leagueMatch(m,leagueId,sport)) continue; m.strStatus=m.strStatus||"Final"; if (!isOldFinal(m)) pushUnique(out,m); }
  }

  out.sort(sortForDisplay);
  return out.slice(0,n);
}

// ===== cached wrappers =====
async function getSoccerEPL(n){
  const key=`OUT:soccer_epl:${n}`;
  const c=getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const data=await buildSoccerEPL(n); setCache(key,data,TTL.OUT); return data; };
  if (c.hit && !c.fresh) { withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}
async function getSingleCached(sport, leagueId, n){
  const key=`OUT:${sport}:${leagueId}:${n}`;
  const c=getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const data=await buildSingle(sport,leagueId,n); setCache(key,data,TTL.OUT); return data; };
  if (c.hit && !c.fresh) { withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ===== routes =====
app.get("/scores/soccer", async (req,res)=>{
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT, 10) || DEFAULT_COUNT));
    const items = await getSoccerEPL(n);
    res.json(items.map(formatMatch));
  }catch(e){ console.error("soccer error:",e); res.status(500).json({error:"internal"}); }
});
app.get("/scores/nba", async (req,res)=>serveSingle(req,res,"basketball",        4387));
app.get("/scores/nfl", async (req,res)=>serveSingle(req,res,"american_football", 4391));
app.get("/scores/nhl", async (req,res)=>serveSingle(req,res,"ice_hockey",        4380));

async function serveSingle(req,res,sport,leagueId){
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT, 10) || DEFAULT_COUNT));
    const items = await getSingleCached(sport, leagueId, n);
    res.json(items.map(formatMatch));
  }catch(e){ console.error(`${sport} error:`,e); res.status(500).json({error:"internal"}); }
}

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
