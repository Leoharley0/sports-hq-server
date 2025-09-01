// server.js — v20 “EPL-only soccer, no day-scan, 10 rows guaranteed”
// Order: Finals (<=15m) → Live → Next → Season(current,next,prev). No eventsday() for soccer.

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v20 (EPL-only; no day-scan; robust 429 retry; 10 rows)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

// fetch polyfill
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// === ENV ===
const V2_KEY = process.env.TSDB_V2_KEY || "";     // v2 livescore header key
const V1_KEY = process.env.TSDB_V1_KEY || "3";    // v1 path key; "3" is the public key

// === LIMITS / TTLs ===
const DEFAULT_N = 10;
const TTL = {
  LIVE:   15_000,
  NEXT:   5 * 60_000,
  PAST:   10 * 60_000,
  SEASON: 6 * 60 * 60_000,
  OUT:    60_000,
};
const SWR_EXTRA = 5 * 60_000;
const FINAL_KEEP_MS = 15 * 60 * 1000;

const L = { EPL: 4328, NBA: 4387, NFL: 4391, NHL: 4380 };
const SPORT_LABEL = { soccer:"Soccer", basketball:"Basketball", american_football:"American Football", ice_hockey:"Ice Hockey" };

// ===== cache + in-flight dedupe =====
const cache = new Map();
const inflight = new Map();
function getC(k){ const e=cache.get(k); if(!e) return {hit:false}; const now=Date.now(); if(now<=e.exp) return {hit:true,fresh:true,val:e.val}; if(now<=e.swr) return {hit:true,fresh:false,val:e.val}; return {hit:false}; }
function setC(k,val,ttl){ const now=Date.now(); cache.set(k,{val,exp:now+ttl,swr:now+ttl+SWR_EXTRA}); }
async function withInflight(k,fn){ if(inflight.has(k)) return inflight.get(k); const p=(async()=>{ try{return await fn();} finally{inflight.delete(k);} })(); inflight.set(k,p); return p; }

// ===== fetch with retry (handles 429/5xx) =====
const COMMON_HEADERS = { "Accept":"application/json", "User-Agent":"SportsHQ/1.0 (+render.com)" };
const sleep = ms => new Promise(r => setTimeout(r,ms));
async function fetchJsonRetry(url, extraHeaders={}, tries=4, baseDelay=650){
  let lastErrMsg = "fetch failed";
  for(let i=0;i<tries;i++){
    try{
      const res = await fetch(url, { headers: { ...COMMON_HEADERS, ...extraHeaders } });
      const txt = await res.text();
      if (res.status === 429 || res.status >= 500){
        const ra = Number(res.headers?.get("retry-after")) || 0;
        const wait = (ra ? ra*1000 : baseDelay*Math.pow(2,i)) * (0.75 + Math.random()*0.5);
        console.warn(`[${res.status}] wait ${Math.round(wait)}ms :: ${url}`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} | ${txt.slice(0,160)}`);
      return JSON.parse(txt);
    }catch(e){
      lastErrMsg = e?.message || lastErrMsg;
      const wait = baseDelay*Math.pow(2,i) * (0.75 + Math.random()*0.5);
      console.warn(`[retry] ${lastErrMsg} -> wait ${Math.round(wait)}ms :: ${url}`);
      await sleep(wait);
    }
  }
  console.error(`[FAIL] ${lastErrMsg} :: ${url}`);
  return null;
}
async function memoJson(url, ttl, extraHeaders={}){
  const key = `U:${url}`;
  const c = getC(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher = async()=>{ const j=await fetchJsonRetry(url, extraHeaders); if(j) setC(key,j,ttl); return j || c.val || null; };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
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
function isRecentFinal(m){ const raw=m.strStatus||m.strProgress||""; if(!isFinalWord(raw)) return false; const ms=eventMillis(m); if(!isFinite(ms)) return false; return (Date.now()-ms) <= FINAL_KEEP_MS; }
function normalizeStatus(m){
  const s1=pickScore(m.intHomeScore??m.intHomeGoals), s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const raw=String(m.strStatus||m.strProgress||"").trim(), has=(s1!==null)||(s2!==null);
  if (isFinalWord(raw)) return "Final";
  if (isLiveWord(raw))  return has ? "LIVE" : "Scheduled";
  if (!raw||raw==="NS"||/scheduled|preview/i.test(raw)) return "Scheduled";
  return has ? raw : "Scheduled";
}
function sortForDisplay(a,b){
  const rank = s => s==="Final"?0 : s==="LIVE"?1 : 2;
  const sa=normalizeStatus(a), sb=normalizeStatus(b);
  if (rank(sa)!==rank(sb)) return rank(sa)-rank(sb);
  const ta=eventMillis(a), tb=eventMillis(b);
  const aBad=!isFinite(ta), bBad=!isFinite(tb);
  if (aBad && !bBad) return +1;
  if (!aBad && bBad) return -1;
  if (sa==="Final") return tb-ta;
  return ta-tb;
}
function matchKey(m){ return m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`; }
function pushUnique(arr,m){ const k=matchKey(m); if(!arr.some(x=>matchKey(x)===k)) arr.push(m); }

// ===== v1/v2 wrappers =====
const V1 = p => `https://www.thesportsdb.com/api/v1/json/${V1_KEY}/${p}`;
async function v1PastLeague(id){ const j=await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }
async function v1NextLeague(id){ const j=await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(V1(`eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`), TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v2Livescore(sport){
  const s=sport.replace(/_/g," ");
  const urls=[
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out=[]; for(const u of urls){ const j=await memoJson(u, TTL.LIVE, V2_KEY?{"X-API-KEY":V2_KEY}:{});
    if (j?.livescore?.length) out.push(...j.livescore);
  }
  return out;
}

// ===== seasons =====
function crossSeasonFor(d=new Date()){ const y=d.getUTCFullYear(), m=d.getUTCMonth()+1; const start=(m>=7)?y:y-1; return `${start}-${start+1}`; }
function seasonsFor(leagueId, sport){
  if (leagueId===L.NFL || sport==="american_football"){ const y=(new Date()).getUTCFullYear(); return [String(y), String(y+1)]; }
  const c=crossSeasonFor(); const prev=c.replace(/^\d+/,x=>String(+x-1)); const next=c.replace(/^\d+/,x=>String(+x+1)); return [c,next,prev];
}

// ===== builders =====
async function buildEPL(n){
  const finals=[], live=[], future=[];
  // Finals
  for (const m of await v1PastLeague(L.EPL)) if (isRecentFinal(m)) pushUnique(finals,m);

  // Live (EPL only)
  for (const m of await v2Livescore("soccer")) if (String(m.idLeague||"")==String(L.EPL) && !isRecentFinal(m)) pushUnique(live,m);

  // Next league (near-term)
  const now = Date.now();
  const next = (await v1NextLeague(L.EPL)).sort((a,b)=>eventMillis(a)-eventMillis(b));
  for (const m of next){ const ms=eventMillis(m); if (isFinite(ms) && ms>=now) pushUnique(future,m); }

  // Seasons (current + next + prev) → keep FUTURE only
  for (const s of seasonsFor(L.EPL,"soccer")){
    const rows = await v1Season(L.EPL, s);
    for (const m of rows||[]){ const ms=eventMillis(m); if (isFinite(ms) && ms>=now) pushUnique(future,m); }
    if (future.length >= n*3) break; // don’t over-pull
  }

  // Merge by order and slice
  const merged = [...finals, ...live, ...future].sort(sortForDisplay).slice(0, n);
  console.log(`[epl] F=${finals.length} L=${live.length} Fut=${future.length} -> out=${merged.length}`);
  return merged;
}

async function buildSingle({ sport, leagueId, n }){
  const finals=[], live=[], future=[];
  const now = Date.now();

  for (const m of await v1PastLeague(leagueId)) if (isRecentFinal(m)) pushUnique(finals,m);
  for (const m of await v2Livescore(sport)) if (String(m.idLeague||"")==String(leagueId) && !isRecentFinal(m)) pushUnique(live,m);

  const next = (await v1NextLeague(leagueId)).sort((a,b)=>eventMillis(a)-eventMillis(b));
  for (const m of next){ const ms=eventMillis(m); if (isFinite(ms) && ms>=now) pushUnique(future,m); }

  for (const s of seasonsFor(leagueId, sport)){
    const rows = await v1Season(leagueId, s);
    for (const m of rows||[]){ const ms=eventMillis(m); if (isFinite(ms) && ms>=now) pushUnique(future,m); }
    if (future.length >= n*3) break;
  }

  const merged = [...finals, ...live, ...future].sort(sortForDisplay).slice(0,n);
  console.log(`[${sport}:${leagueId}] F=${finals.length} L=${live.length} Fut=${future.length} -> out=${merged.length}`);
  return merged;
}

// ===== formatting =====
function formatMatch(m){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"";
  const away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=pickScore(m.intHomeScore??m.intHomeGoals);
  const s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const ms=eventMillis(m);
  return { team1:home, team2:away, score1:s1===null?"N/A":String(s1), score2:s2===null?"N/A":String(s2),
           headline:`${home} vs ${away} - ${normalizeStatus(m)}`, start:isFinite(ms)?new Date(ms).toISOString():null };
}

// ===== cached board wrappers =====
async function boardCached(key, ttl, builder){
  const c=getC(key); if (c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const data=await builder(); setC(key,data,ttl); return data; };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ===== routes =====
app.get("/scores/soccer", async (req,res)=>{
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_N,10) || DEFAULT_N));
    const rows = await boardCached(`OUT:epl:${n}`, TTL.OUT, ()=>buildEPL(n));
    res.json(rows.map(formatMatch));
  }catch(e){ console.error("soccer error:",e); res.status(500).json({error:"internal"}); }
});
app.get("/scores/nba", async (req,res)=>serveSingle(req,res,"basketball",        L.NBA));
app.get("/scores/nfl", async (req,res)=>serveSingle(req,res,"american_football", L.NFL));
app.get("/scores/nhl", async (req,res)=>serveSingle(req,res,"ice_hockey",        L.NHL));
async function serveSingle(req,res,sport,leagueId){
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_N,10) || DEFAULT_N));
    const rows = await boardCached(`OUT:${sport}:${leagueId}:${n}`, TTL.OUT, ()=>buildSingle({ sport, leagueId, n }));
    res.json(rows.map(formatMatch));
  }catch(e){ console.error(`${sport} error:`,e); res.status(500).json({error:"internal"}); }
}

// quick diag
app.get("/diag/epl", async (_req,res)=>{
  try{
    const past=(await v1PastLeague(L.EPL))?.length||0;
    const live=(await v2Livescore("soccer")).filter(x=>String(x.idLeague||"")==String(L.EPL)).length;
    const next=(await v1NextLeague(L.EPL))?.length||0;
    const seasons = await Promise.all(seasonsFor(L.EPL,"soccer").map(s=>v1Season(L.EPL,s)));
    const seasonRaw = seasons.reduce((a,j)=>a+((j&&j.length)||0),0);
    res.json({ board:"epl", counts:{ past, live, next, seasonRaw } });
  }catch(e){ res.json({error:String(e)}) }
});

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
