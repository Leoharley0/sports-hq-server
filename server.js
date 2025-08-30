// server.js — v25: robust date-only/TBA parsing; unified single-league builder; no day-scan
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v25 (robust date-only/TBA; unified builder; no day-scan)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ENV
const V2_KEY = process.env.TSDB_V2_KEY || "";
const V1_KEY = process.env.TSDB_V1_KEY || "";
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY missing (live may be limited)");
if (!V1_KEY) console.warn("ℹ️ TSDB_V1_KEY missing; using shared/test key");

// CONFIG
const DEFAULT_COUNT = 10;
const TTL = { LIVE:15_000, NEXT:5*60_000, SEASON:3*60*60_000, PAST:10*60_000, OUT:60_000 };
const SWR_EXTRA = 5*60_000;

const cache=new Map(), inflight=new Map();
function getCache(k){const e=cache.get(k); if(!e) return {hit:false}; const now=Date.now(); if(now<=e.exp) return {hit:true,fresh:true,val:e.val}; if(now<=e.swr) return {hit:true,fresh:false,val:e.val}; return {hit:false};}
function setCache(k,val,ttl){const now=Date.now(); cache.set(k,{val,exp:now+ttl,swr:now+ttl+SWR_EXTRA});}
async function withInflight(k,fn){ if(inflight.has(k)) return inflight.get(k); const p=(async()=>{ try{return await fn();} finally{inflight.delete(k);} })(); inflight.set(k,p); return p; }

const COMMON_HEADERS={ "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const jitter=ms=>ms+Math.floor(Math.random()*(ms/3));
async function fetchJsonRetry(url, extra={}, tries=4, baseDelay=650){
  let lastErr;
  for (let i=0;i<tries;i++){
    try{
      const res=await fetch(url,{headers:{...COMMON_HEADERS,...extra}});
      const txt=await res.text();
      if(res.status===429){ const ra=Number(res.headers?.get("retry-after"))||0; const wait=jitter(ra?ra*1000:baseDelay*Math.pow(2,i)); console.warn(`[429] wait ${wait}ms :: ${url}`); await sleep(wait); continue; }
      if(!res.ok) throw new Error(`${res.status} ${res.statusText} | ${txt.slice(0,160)}`);
      return JSON.parse(txt);
    }catch(e){ lastErr=e; const wait=jitter(baseDelay*Math.pow(2,i)); console.warn(`[retry] ${e.message}; wait ${wait}ms :: ${url}`); await sleep(wait); }
  }
  console.error(`[FAIL] ${lastErr?.message} :: ${url}`); return null;
}
async function memoJson(url, ttl, extra={}){
  const key=`URL:${url}`; const c=getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const j=await fetchJsonRetry(url, extra); if(j) setCache(key,j,ttl); return j || c.val || null; };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ---------- time / status helpers (hardened) ----------
function pickScore(v){ return (v===undefined||v===null||v===""||v==="N/A")?null:v; }
function isLiveWord(s=""){ s=(s+"").toLowerCase(); return s.includes("live")||s.includes("in play")||s.includes("half")||s==="ht"||s.includes("ot"); }
function isFinalWord(s=""){ s=(s+"").toLowerCase(); return s.includes("final")||s==="ft"||s.includes("full time"); }

function normalizeStatus(m,s1,s2){
  const raw=String(m.strStatus||m.strProgress||"").trim(), has=(s1!==null)||(s2!==null);
  if (isFinalWord(raw)) return "Final";
  if (isLiveWord(raw))  return has ? "LIVE" : "Scheduled";
  if (!raw||raw==="NS"||raw.toLowerCase()==="scheduled"||raw.toLowerCase()==="preview") return "Scheduled";
  return has ? raw : "Scheduled";
}

const FINAL_KEEP_MS = 15*60*1000;

// New: robust extraction accepting date-only strings
function eventMillis(m){
  // 1) explicit epoch fields first
  if (m.strTimestampMS){ const n=+m.strTimestampMS; if (Number.isFinite(n)) return n; }
  if (m.strTimestamp){ const n=+m.strTimestamp*1000; if (Number.isFinite(n)) return n; }

  // 2) generic ISO parse with time (works when time provided)
  const tryIso = (d,t)=>{
    if(!d) return NaN;
    const tt = (t && typeof t==="string" && t.trim()) ? t.trim() : "00:00:00";
    const hasTZ=/[zZ]$|[+\-]\d\d:?\d\d$/.test(tt);
    const iso = `${d}T${tt}${hasTZ?"":"Z"}`;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : NaN;
  };
  let ms = tryIso(m.dateEvent, m.strTime); if (Number.isFinite(ms)) return ms;
  ms = tryIso(m.dateEventLocal||m.dateEvent, m.strTimeLocal||m.strTime); if (Number.isFinite(ms)) return ms;

  // 3) NEW: if date-only like YYYY-MM-DD (no time works), anchor at 12:00 UTC to avoid TZ flips
  const takeDateOnly = d => {
    if (!d) return NaN;
    const s = String(d).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return NaN;
    const Y=+m[1], M=+m[2]-1, D=+m[3];
    return Date.UTC(Y, M, D, 12, 0, 0);
  };
  ms = takeDateOnly(m.dateEvent); if (Number.isFinite(ms)) return ms;
  ms = takeDateOnly(m.dateEventLocal); if (Number.isFinite(ms)) return ms;

  return NaN;
}

function isRecentFinal(m){
  const raw=m.strStatus||m.strProgress||"";
  if (!isFinalWord(raw)) return false;
  const ms=eventMillis(m); if(!Number.isFinite(ms)) return false;
  return (Date.now()-ms) <= FINAL_KEEP_MS;
}

function computedStatus(m){
  const s1=pickScore(m.intHomeScore??m.intHomeGoals), s2=pickScore(m.intAwayScore??m.intAwayGoals);
  return normalizeStatus(m,s1,s2);
}
function matchKey(m){ return m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`; }
function pushUnique(arr,m){ const k=matchKey(m); if(!arr.some(x=>matchKey(x)===k)) arr.push(m); }
function sortForDisplay(a,b){
  const R=s=>s==="Final"?0:s==="LIVE"?1:2;
  const sa=computedStatus(a), sb=computedStatus(b);
  if (R(sa)!==R(sb)) return R(sa)-R(sb);
  const ta=eventMillis(a), tb=eventMillis(b);
  const aBad=!Number.isFinite(ta), bBad=!Number.isFinite(tb);
  if (aBad && !bBad) return +1;
  if (!aBad && bBad) return -1;
  if (sa==="Final") return tb-ta;
  return ta-tb;
}

// ---------- TSDB wrappers ----------
async function v2Livescore(sport){
  const s=sport.replace(/_/g," ");
  const urls=[`https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
              `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`];
  const out=[]; for (const u of urls){ const j=await memoJson(u, TTL.LIVE, V2_KEY?{"X-API-KEY":V2_KEY}:{}); if (Array.isArray(j?.livescore)) out.push(...j.livescore); }
  return out;
}
const V1 = p => `https://www.thesportsdb.com/api/v1/json/${V1_KEY || "3"}/${p}`;
async function v1NextLeague(id){ const j=await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(V1(`eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`), TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }

// ---------- seasons ----------
function guessSeasonCrossYear(){ const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1; const start=(m>=7)?y:y-1; return `${start}-${start+1}`; }
function nextCross(s){ const a=parseInt(s.split("-")[0],10); return `${a+1}-${a+2}`; }
function prevCross(s){ const a=parseInt(s.split("-")[0],10); return `${a-1}-${a}`; }
function seasonCandidatesSoccer(){ const c=guessSeasonCrossYear(), y=(new Date()).getUTCFullYear(); return [c, nextCross(c), prevCross(c), String(y), String(y+1), String(y-1)]; }
function seasonCandidatesNFL(){ const y=(new Date()).getUTCFullYear(), c=guessSeasonCrossYear(); return [String(y), String(y+1), String(y-1), c, nextCross(c), prevCross(c)]; }
function seasonCandidatesDefault(){ const c=guessSeasonCrossYear(); return [c, nextCross(c), prevCross(c)]; }

// ---------- leagues ----------
const L = { EPL:4328, NBA:4387, NFL:4391, NHL:4380 };

// ---------- format ----------
function formatMatch(m){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"", away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=pickScore(m.intHomeScore??m.intHomeGoals), s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const status=normalizeStatus(m,s1,s2), ms=eventMillis(m);
  return { team1:home, team2:away, score1:s1===null?"N/A":String(s1), score2:s2===null?"N/A":String(s2),
           headline:`${home} vs ${away} - ${status}`, start:Number.isFinite(ms)?new Date(ms).toISOString():null };
}

// ---------- unified single-league builder ----------
async function buildSingle({ sport, leagueId, n, seasons }){
  const now=Date.now();
  const finals=[], live=[], sched=[];

  const past=await v1PastLeague(leagueId);
  const finalsRaw=(past||[]).filter(isRecentFinal).sort((a,b)=>eventMillis(b)-eventMillis(a));
  for (const m of finalsRaw) pushUnique(finals, m);
  console.log(`[debug ${sport}:${leagueId}] finalsRaw=${finalsRaw.length}`);

  const lsAll=await v2Livescore(sport);
  const liveRaw=(lsAll||[]).filter(m=>String(m.idLeague||"")===String(leagueId)&&!isRecentFinal(m));
  for (const m of liveRaw) pushUnique(live, m);
  console.log(`[debug ${sport}:${leagueId}] liveRaw=${liveRaw.length}`);

  const next=await v1NextLeague(leagueId);
  const nextFut=(next||[]).filter(e=>{ const ms=eventMillis(e); return Number.isFinite(ms) && ms>=now; })
                          .sort((a,b)=>eventMillis(a)-eventMillis(b));
  for (const m of nextFut){ if(finals.length+live.length+sched.length>=n) break; pushUnique(sched,m); }
  console.log(`[debug ${sport}:${leagueId}] nextFut=${nextFut.length}`);

  if (finals.length+live.length+sched.length < n){
    for (const s of seasons){
      if (finals.length+live.length+sched.length >= n) break;
      const rows=await v1Season(leagueId, s);
      const rawCount=(rows||[]).length;
      const fut=(rows||[]).filter(e=>{
        // Accept future if either:
        //  - eventMillis is finite and >= now (normal), or
        //  - date-only string parsed to noon UTC and >= now (handled inside eventMillis)
        const ms=eventMillis(e);
        return Number.isFinite(ms) && ms>=now;
      }).sort((a,b)=>eventMillis(a)-eventMillis(b));
      console.log(`[debug ${sport}:${leagueId}] season ${s} raw=${rawCount} fut=${fut.length}`);
      for (const m of fut){ if(finals.length+live.length+sched.length>=n) break; pushUnique(sched,m); }
    }
  }

  const out=[...finals, ...live, ...sched].sort(sortForDisplay).slice(0,n);
  console.log(`[${sport}:${leagueId}] F=${finals.length} L=${live.length} S=${sched.length} -> out=${out.length}`);
  return out;
}

// cache wrapper
async function getBoardCached(key, builder){
  const c=getCache(key); if(c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const data=await builder(); const full=Array.isArray(data)&&data.length>=(DEFAULT_COUNT||10); setCache(key,data, full?TTL.OUT:8_000); return data; };
  if(c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// routes
app.get("/scores/soccer", async (req,res)=>{
  try{
    const n=Math.max(5, Math.min(10, parseInt(req.query.n||DEFAULT_COUNT,10)||DEFAULT_COUNT));
    const items=await getBoardCached(`OUT:soccer_epl_v25:${n}`, () =>
      buildSingle({ sport:"soccer", leagueId:L.EPL, n, seasons:seasonCandidatesSoccer() })
    );
    console.log(`/scores/soccer -> ${items.length} items (n=${n})`);
    res.json(items.map(formatMatch));
  }catch(e){ console.error("soccer error:", e); res.status(500).json({error:"internal"}); }
});

app.get("/scores/nfl", async (req,res)=>serveSingle(req,res,"american_football", L.NFL, seasonCandidatesNFL()));
app.get("/scores/nba", async (req,res)=>serveSingle(req,res,"basketball",        L.NBA, seasonCandidatesDefault()));
app.get("/scores/nhl", async (req,res)=>serveSingle(req,res,"ice_hockey",        L.NHL, seasonCandidatesDefault()));

async function serveSingle(req,res,sport,leagueId,seasons){
  try{
    const n=Math.max(5, Math.min(10, parseInt(req.query.n||DEFAULT_COUNT,10)||DEFAULT_COUNT));
    const items=await getBoardCached(`OUT:${sport}:${leagueId}:v25:${n}`, () =>
      buildSingle({ sport, leagueId, n, seasons })
    );
    console.log(`/scores/${sport} -> ${items.length} items (n=${n})`);
    res.json(items.map(formatMatch));
  }catch(e){ console.error(`${sport} error:`, e); res.status(500).json({error:"internal"}); }
}

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
