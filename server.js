// server.js — v11: 429-resilient SWR cache + next-merge soccer + throttled fallbacks
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v11 (SWR + 429 backoff + next-merge soccer)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

// Polyfill fetch for Node < 18
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ===== ENV KEYS =====
const V2_KEY = process.env.TSDB_V2_KEY || ""; // v2 livescore header (optional)
const V1_KEY = process.env.TSDB_V1_KEY || ""; // v1 path key (may be shared/test)
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY missing; live may be limited");
if (!V1_KEY) console.warn("ℹ️ TSDB_V1_KEY missing; using public test key behavior");

// ===== CONFIG =====
const DEFAULT_COUNT = 15;
const TTL = {
  LIVE:   15_000,          // 15s
  NEXT:   5 * 60_000,      // 5m
  SEASON: 2 * 60 * 60_000, // 2h
  DAY:    30 * 60_000,     // 30m
  PAST:   10 * 60_000,     // 10m
  OUT:    60_000           // 60s output (serve cached quickly)
};
// SWR: how long we still serve stale data while a refresh is happening
const SWR_EXTRA = 5 * 60_000; // 5 minutes

// Global throttle for expensive "day" scans (token bucket)
const DAY_TOKENS_MAX = 8;          // at most 8 day calls available at once
const DAY_TOKENS_REFILL_MS = 15_000; // add 1 token every 15s
let DAY_TOKENS = DAY_TOKENS_MAX;
setInterval(() => { DAY_TOKENS = Math.min(DAY_TOKENS_MAX, DAY_TOKENS + 1); }, DAY_TOKENS_REFILL_MS);

const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (ms) => ms + Math.floor(Math.random() * (ms / 3));

// ===== tiny cache (SWR) + in-flight dedupe =====
const cache = new Map(); // key -> { val, exp, swr }
const inflight = new Map(); // key -> Promise

function getCache(key) {
  const ent = cache.get(key);
  if (!ent) return { hit:false };
  const now = Date.now();
  if (now <= ent.exp) return { hit:true, fresh:true, val:ent.val };
  if (now <= ent.swr) return { hit:true, fresh:false, val:ent.val };
  return { hit:false };
}
function setCache(key, val, ttl) {
  const now = Date.now();
  cache.set(key, { val, exp: now + ttl, swr: now + ttl + SWR_EXTRA });
}

async function withInflight(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try { return await fn(); }
    finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

// ===== fetch with retry/backoff =====
async function fetchJsonRetry(url, extra = {}, tries = 4, baseDelay = 600) {
  let lastErr;
  for (let i=0; i<tries; i++) {
    try {
      const res = await fetch(url, { headers: { ...COMMON_HEADERS, ...extra } });
      const txt = await res.text();
      if (res.status === 429) {
        const ra = Number(res.headers?.get("retry-after")) || 0;
        const wait = jitter(ra ? ra*1000 : baseDelay * Math.pow(2, i));
        console.warn(`[429] backoff ${wait}ms :: ${url}`);
        await sleep(wait); continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} | ${txt.slice(0,160)}`);
      return JSON.parse(txt);
    } catch (e) {
      lastErr = e;
      const wait = jitter(baseDelay * Math.pow(2, i));
      console.warn(`[retry] ${e.message}; wait ${wait}ms :: ${url}`);
      await sleep(wait);
    }
  }
  console.error(`[FAIL] ${lastErr?.message} :: ${url}`);
  return null;
}

async function memoJson(url, ttl, extra = {}) {
  const k = `URL:${url}`;
  const c = getCache(k);
  if (c.hit && c.fresh) return c.val;

  const fetcher = async () => {
    const j = await fetchJsonRetry(url, extra);
    if (j) setCache(k, j, ttl);
    return j || c.val || null; // fall back to stale if fetch failed
  };

  // serve stale immediately, refresh in background
  if (c.hit && !c.fresh) { withInflight(k, fetcher); return c.val; }
  return withInflight(k, fetcher);
}

// ===== time / status helpers =====
function cleanTime(t){ if(!t) return "00:00:00"; const s=String(t).trim(); return (/^tba$|^tbd$/i.test(s))?"00:00:00":s; }
function toMillis(d,t){ if(!d) return NaN; const tt=cleanTime(t); const hasTZ=/[zZ]$|[+\-]\d\d:?\d\d$/.test(tt); const ms=Date.parse(`${d}T${tt}${hasTZ?"":"Z"}`); return Number.isNaN(ms)?NaN:ms; }
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
async function v1NextLeague(id){ const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY||"3"}/eventsnextleague.php?id=${id}`, TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY||"3"}/eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`, TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY||"3"}/eventspastleague.php?id=${id}`, TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }
const SPORT_LABEL={ soccer:"Soccer", basketball:"Basketball", american_football:"American Football", ice_hockey:"Ice Hockey" };
async function v1EventsDay(sport, ymd){
  // token bucket to avoid storms
  if (DAY_TOKENS <= 0) { console.warn(`[DAY throttle] skip ${sport} ${ymd}`); return []; }
  DAY_TOKENS--;
  const label=SPORT_LABEL[sport]||sport;
  const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY||"3"}/eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`, TTL.DAY);
  return Array.isArray(j?.events)?j.events:[];
}

// ===== league matching =====
function leagueMatch(m, leagueId, sport){
  const idOk = String(m.idLeague||"")===String(leagueId);
  const name = String(m.strLeague||"").toLowerCase();
  if (sport==="american_football") return idOk || name.includes("nfl");
  if (sport==="basketball")        return idOk; // NBA only
  if (sport==="ice_hockey")        return idOk || name.includes("nhl");
  return idOk; // soccer when single id
}

// ===== Soccer (multi-league) next-only merge =====
const SOCCER_IDS = [4328, 4331, 4335, 4334]; // EPL, BL, LaLiga, Ligue1

function onlyFutureIDs(rows, idSet){
  const now=Date.now();
  return (rows||[]).filter(m=>{
    if (!idSet.has(String(m.idLeague||""))) return false;
    const ms=eventMillis(m); return isFinite(ms) && ms>=now;
  });
}

async function buildSoccerNext(n){
  const ids = SOCCER_IDS, idSet=new Set(ids.map(String));
  const out=[];

  // LIVE once for sport
  const live = await v2Livescore("soccer");
  for (const m of live||[]) if (idSet.has(String(m.idLeague||"")) && !isOldFinal(m)) pushUnique(out,m);
  console.log(`[soccer live] -> ${out.length}`);

  // NEXT per league (4 calls only)
  let cand=[];
  for (const lid of ids){
    const r = await v1NextLeague(lid);
    console.log(`[soccer next] ${lid} -> ${r.length}`);
    cand.push(...r);
  }
  cand = onlyFutureIDs(cand, idSet).sort((a,b)=>eventMillis(a)-eventMillis(b));
  for (const m of cand){ if (out.length>=n) break; pushUnique(out,m); }
  console.log(`[soccer merge] cand=${cand.length} out=${out.length}/${n}`);

  if (out.length<n){
    // gentle day scan, limited by token bucket
    const today=new Date();
    for (let w=0; w<3 && out.length<n; w++){
      for (let d=0; d<7 && out.length<n; d++){
        await sleep(900);
        const dt=new Date(today.getTime()+(w*7+d)*86400000);
        const ymd=dt.toISOString().slice(0,10);
        const rows=await v1EventsDay("soccer", ymd);
        const fut=onlyFutureIDs(rows, idSet).sort((a,b)=>eventMillis(a)-eventMillis(b));
        for (const m of fut){ if (out.length>=n) break; pushUnique(out,m); }
      }
    }
  }

  if (out.length<n){
    // recent finals
    for (const lid of ids){
      if (out.length>=n) break;
      const p = await v1PastLeague(lid);
      p.sort((a,b)=>eventMillis(b)-eventMillis(a));
      for (const m of p){
        if (out.length>=n) break;
        if (String(m.idLeague||"")!==String(lid)) continue;
        m.strStatus = m.strStatus || "Final";
        if (isOldFinal(m)) continue;
        pushUnique(out,m);
      }
    }
  }

  out.sort(sortForDisplay);
  return out.slice(0,n);
}

// cache wrapper (SWR) for soccer
async function getSoccer(n){
  const key = `OUT:soccer:${n}`;
  const c = getCache(key);
  if (c.hit && c.fresh) return c.val;

  const fetcher = async () => {
    const data = await buildSoccerNext(n);
    setCache(key, data, TTL.OUT);
    return data;
  };

  if (c.hit && !c.fresh) { withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ===== single-league builder for NBA/NFL/NHL =====
async function buildSingle(sport, leagueId, n){
  const out=[];
  const live=await v2Livescore(sport);
  for (const m of live||[]) if (leagueMatch(m,leagueId,sport) && !isOldFinal(m)) pushUnique(out,m);

  if (out.length<n){
    const e=await v1NextLeague(leagueId);
    e.sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of e){ if (out.length>=n) break; if (leagueMatch(m,leagueId,sport)) pushUnique(out,m); }
  }

  // light day fill (throttled by bucket)
  const today=new Date();
  for (let w=0; w<2 && out.length<n; w++){
    for (let d=0; d<7 && out.length<n; d++){
      await sleep(900);
      const ymd=new Date(today.getTime()+(w*7+d)*86400000).toISOString().slice(0,10);
      const rows=await v1EventsDay(sport, ymd);
      for (const m of rows){
        if (out.length>=n) break;
        if (!leagueMatch(m,leagueId,sport)) continue;
        const ms=eventMillis(m); if (isFinite(ms) && ms<Date.now()) continue;
        pushUnique(out,m);
      }
    }
  }

  if (out.length<n){
    const p=await v1PastLeague(leagueId);
    p.sort((a,b)=>eventMillis(b)-eventMillis(a));
    for (const m of p){ if (out.length>=n) break; if (!leagueMatch(m,leagueId,sport)) continue; m.strStatus=m.strStatus||"Final"; if (!isOldFinal(m)) pushUnique(out,m); }
  }

  out.sort(sortForDisplay);
  return out.slice(0,n);
}
async function getSingleCached(sport, leagueId, n){
  const key=`OUT:${sport}:${leagueId}:${n}`;
  const c=getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const data=await buildSingle(sport,leagueId,n); setCache(key,data,TTL.OUT); return data; };
  if (c.hit && !c.fresh) { withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ===== output shape =====
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

// ===== routes =====
app.get("/scores/soccer", async (req,res)=>{
  try{
    const n = Math.max(5, Math.min(20, parseInt(req.query.n || DEFAULT_COUNT, 10) || DEFAULT_COUNT));
    const items = await getSoccer(n);
    console.log(`/scores/soccer -> ${items.length} items`);
    res.json(items.map(formatMatch));
  }catch(e){ console.error("soccer error:",e); res.status(500).json({error:"internal"}); }
});
app.get("/scores/nba",  async (req,res)=>serveSingle(req,res,"basketball",        4387));
app.get("/scores/nfl",  async (req,res)=>serveSingle(req,res,"american_football", 4391));
app.get("/scores/nhl",  async (req,res)=>serveSingle(req,res,"ice_hockey",        4380));

async function serveSingle(req,res,sport,leagueId){
  try{
    const n = Math.max(5, Math.min(20, parseInt(req.query.n || DEFAULT_COUNT, 10) || DEFAULT_COUNT));
    const items = await getSingleCached(sport, leagueId, n);
    console.log(`/scores/${sport} -> ${items.length} items`);
    res.json(items.map(formatMatch));
  }catch(e){ console.error(`${sport} error:`,e); res.status(500).json({error:"internal"}); }
}

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
