// server.js — v20: Fix fake-LIVE + don't cache tiny results + NFL/MLB day top-up.

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v20 (strict LIVE, no-cache tiny, NFL/MLB day fill)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

const V2_KEY = process.env.TSDB_V2_KEY || "";
const V1_KEY = process.env.TSDB_V1_KEY || "";
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY missing");
if (!V1_KEY) console.warn("ℹ️ TSDB_V1_KEY missing; falling back to public key");

const DEFAULT_COUNT = 10;
const TTL = { LIVE:15e3, NEXT:5*60e3, SEASON:6*60*60e3, DAY:30*60e3, PAST:10*60e3, OUT:60e3 };
const SWR_EXTRA = 5*60e3;
const FINAL_KEEP_MS = 15*60*1000;

const SPORT_EXPECTED_MIN = { basketball:135, ice_hockey:150, american_football:195, baseball:210 };

const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
const cache = new Map(), inflight = new Map();

function getCache(k){ const e=cache.get(k); if(!e) return {hit:false}; const n=Date.now(); if(n<=e.exp) return {hit:true,fresh:true,val:e.val}; if(n<=e.swr) return {hit:true,fresh:false,val:e.val}; return {hit:false}; }
function setCache(k,val,ttl){ const n=Date.now(); cache.set(k,{val,exp:n+ttl,swr:n+ttl+SWR_EXTRA}); }
async function withInflight(k,fn){ if(inflight.has(k)) return inflight.get(k); const p=(async()=>{try{return await fn();}finally{inflight.delete(k);}})(); inflight.set(k,p); return p; }

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const jitter = ms => ms + Math.floor(Math.random()*(ms/3));

async function fetchJsonRetry(url, extra={}, tries=4, base=650){
  let last;
  for(let i=0;i<tries;i++){
    try{
      const res=await fetch(url,{headers:{...COMMON_HEADERS,...extra}});
      const txt=await res.text();
      if(res.status===429){
        const ra=Number(res.headers?.get("retry-after"))||0;
        const wait=jitter(ra?ra*1000:base*Math.pow(2,i));
        console.warn(`[429] wait ${wait}ms :: ${url}`); await sleep(wait); continue;
      }
      if(!res.ok) throw new Error(`${res.status} ${res.statusText} | ${txt.slice(0,160)}`);
      return JSON.parse(txt);
    }catch(e){ last=e; const wait=jitter(base*Math.pow(2,i)); console.warn(`[retry] ${e.message}; wait ${wait}ms :: ${url}`); await sleep(wait); }
  }
  console.error(`[FAIL] ${last?.message} :: ${url}`); return null;
}
async function memoJson(url, ttl, extra={}){
  const k=`URL:${url}`, c=getCache(k);
  if(c.hit && c.fresh) return c.val;
  const fetcher = async()=>{ const j=await fetchJsonRetry(url,extra); if(j) setCache(k,j,ttl); return j || c.val || null; };
  if(c.hit && !c.fresh){ withInflight(k,fetcher); return c.val; }
  return withInflight(k,fetcher);
}

function cleanTime(t){ if(!t) return "00:00:00"; const s=String(t).trim(); return (/^tba$|^tbd$/i.test(s))?"00:00:00":s; }
function toMillis(d,t){ if(!d) return NaN; const tt=cleanTime(t); const hasTZ=/[zZ]$|[+\-]\d\d:?\d\d$/.test(tt); const ms=Date.parse(`${d}T${tt}${hasTZ?"":"Z"}`); return Number.isNaN(ms)?NaN:ms; }
function eventMillis(m){
  let ms = toMillis(m.dateEvent, m.strTime); if(!Number.isNaN(ms)) return ms;
  ms = toMillis(m.dateEventLocal||m.dateEvent, m.strTimeLocal||m.strTime); if(!Number.isNaN(ms)) return ms;
  if(m.strTimestampMS){ const n=+m.strTimestampMS; if(!Number.isNaN(n)) return n; }
  if(m.strTimestamp){ const n=+m.strTimestamp*1000; if(!Number.isNaN(n)) return n; }
  if(m.dateEvent){ ms=toMillis(m.dateEvent,"00:00:00Z"); if(!Number.isNaN(ms)) return ms; }
  if(m.dateEventLocal){ ms=toMillis(m.dateEventLocal,"00:00:00Z"); if(!Number.isNaN(ms)) return ms; }
  return NaN;
}
function pickScore(v){ return (v===undefined||v===null||v===""||v==="N/A")?null:Number(v); }
function isLiveWord(s=""){ s=(s+"").toLowerCase(); return s.includes("live")||s.includes("in play")||s.includes("half")||s==="ht"||s.includes("ot")||/^q\d/.test(s)||s.includes("quarter")||s.includes("period"); }
function isFinalWord(s=""){ s=(s+"").toLowerCase(); return s.includes("final")||s==="ft"||s.includes("full time")||s.includes("ended")||s.includes("finished"); }

function strongStatus(m, sport){
  const now=Date.now();
  const raw=(m.strStatus||m.strProgress||"").trim();
  const s1=pickScore(m.intHomeScore??m.intHomeGoals);
  const s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const scored = Number.isFinite(s1) && Number.isFinite(s2) && (s1+s2>0);
  const ms=eventMillis(m);

  if (isFinalWord(raw)) return "Final";

  // Future always scheduled
  if (isFinite(ms) && ms > now + 60*1000) return "Scheduled";

  // Started or starting now — only LIVE with a positive signal
  if (isFinite(ms) && now >= ms - 60*1000) {
    if (isLiveWord(raw) || scored) return "LIVE";
    return "Scheduled";
  }

  // Unknown start: require BOTH a live-ish word and positive scoring
  if (isLiveWord(raw) && scored) return "LIVE";
  return "Scheduled";
}
function isRecentFinal(m){
  const raw=m.strStatus||m.strProgress||"";
  if(!isFinalWord(raw)) return false;
  const ms=eventMillis(m); if(!isFinite(ms)) return false;
  return (Date.now()-ms)<=FINAL_KEEP_MS;
}
function liveETA(m, sport){
  const ms=eventMillis(m);
  const durMin = SPORT_EXPECTED_MIN[sport] || 150;
  if(!isFinite(ms)) return Number.POSITIVE_INFINITY;
  return (ms + durMin*60*1000) - Date.now();
}
function statusGroup(m, sport){
  const s=strongStatus(m, sport);
  return s==="Final"?0:s==="LIVE"?1:2;
}
function sortForDisplay(a,b,sport){
  const ga=statusGroup(a,sport), gb=statusGroup(b,sport);
  if(ga!==gb) return ga-gb;
  const ta=eventMillis(a), tb=eventMillis(b);
  if(ga===0) return (isFinite(tb)?tb:0) - (isFinite(ta)?ta:0); // finals newest
  if(ga===1) return liveETA(a,sport) - liveETA(b,sport);      // live closest finish
  return (isFinite(ta)?ta:Number.POSITIVE_INFINITY) - (isFinite(tb)?tb:Number.POSITIVE_INFINITY); // scheduled soonest
}

async function v2Livescore(sport){
  const s=sport.replace(/_/g," ");
  const urls=[
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out=[]; for(const u of urls){ const j=await memoJson(u,TTL.LIVE,V2_KEY?{"X-API-KEY":V2_KEY}:{});
    if(j?.livescore?.length) out.push(...j.livescore);
  } return out;
}
const V1 = p => `https://www.thesportsdb.com/api/v1/json/${V1_KEY||"3"}/${p}`;
async function v1NextLeague(id){ const j=await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(V1(`eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`), TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }
const SPORT_LABEL={basketball:"Basketball",american_football:"American Football",ice_hockey:"Ice Hockey",baseball:"Baseball"};
async function v1EventsDay(sport, ymd){
  const label=SPORT_LABEL[sport]||sport;
  const j=await memoJson(V1(`eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`), TTL.DAY);
  return Array.isArray(j?.events)?j.events:[];
}

function guessSeasonCrossYear(){ const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1; const start=(m>=7)?y:y-1; return `${start}-${start+1}`; }
function seasonsCrossTriple(){ const c=guessSeasonCrossYear(); const prev=`${parseInt(c)-1}-${parseInt(c)}`; const next=`${parseInt(c)+1}-${parseInt(c)+2}`; return [c,next,prev]; }
function seasonsNFL(){ const y=(new Date()).getUTCFullYear(); const c=guessSeasonCrossYear(); return [String(y), String(y+1), c, `${parseInt(c)-1}-${parseInt(c)}`]; }

const L = { NBA:4387, NFL:4391, NHL:4380, MLB:4424 };

function formatMatch(m,sport){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"";
  const away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=pickScore(m.intHomeScore??m.intHomeGoals);
  const s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const status=strongStatus(m, sport);
  const ms=eventMillis(m);
  return {
    team1:home, team2:away,
    score1:(s1==null)?"N/A":String(s1),
    score2:(s2==null)?"N/A":String(s2),
    headline:`${home} vs ${away} - ${status}`,
    start:isFinite(ms)?new Date(ms).toISOString():null
  };
}

// lightweight day fill for future games (NFL/MLB safety net)
async function dayFill(out, sport, leagueId, want){
  const now=Date.now();
  const today=new Date();
  for(let d=0; d<21 && out.length<want; d++){
    const dt=new Date(today.getTime()+d*86400000).toISOString().slice(0,10);
    const rows=await v1EventsDay(sport, dt);
    const fut=(rows||[]).filter(x => String(x.idLeague||"")===String(leagueId))
                        .filter(x => { const ms=eventMillis(x); return isFinite(ms)&&ms>=now; })
                        .sort((a,b)=>eventMillis(a)-eventMillis(b));
    for(const m of fut){ if(out.length>=want) break; out.push(m); }
  }
}

async function buildSingle({ sport, leagueId, seasons, n }){
  const finals=[], live=[], sched=[];
  const now = Date.now();

  const past = await v1PastLeague(leagueId);
  for(const m of (past||[])) if(isRecentFinal(m)) finals.push(m);

  const ls = await v2Livescore(sport);
  for(const m of (ls||[])) if(String(m.idLeague||"")===String(leagueId) && strongStatus(m,sport)==="LIVE") live.push(m);

  const next=(await v1NextLeague(leagueId)).sort((a,b)=>eventMillis(a)-eventMillis(b));
  for(const m of next){ if(finals.length+live.length+sched.length>=n) break; const ms=eventMillis(m); if(isFinite(ms)&&ms>=now) sched.push(m); }

  if(finals.length+live.length+sched.length<n){
    for(const s of seasons){
      const rows=await v1Season(leagueId,s);
      const fut=(rows||[]).filter(x=>{const ms=eventMillis(x); return isFinite(ms)&&ms>=now;})
                          .sort((a,b)=>eventMillis(a)-eventMillis(b));
      for(const m of fut){ if(finals.length+live.length+sched.length>=n) break; sched.push(m); }
      if(finals.length+live.length+sched.length>=n) break;
    }
  }

  // Extra top-up for NFL/MLB (cheap day scan)
  if((finals.length+live.length+sched.length)<n && (sport==="american_football" || sport==="baseball")){
    await dayFill(sched, sport, leagueId, n-(finals.length+live.length));
  }

  const out=[...finals,...live,...sched].sort((a,b)=>sortForDisplay(a,b,sport)).slice(0,n);
  return out;
}

// don't cache tiny (likely rate-limited) results
async function getBoardCached(key, builder, n){
  const c=getCache(key);
  if(c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const data=await builder(); const len=(data?.length)||0;
    if(len>=Math.max(2, Math.floor(n/2))) setCache(key,data,TTL.OUT); // only cache decent boards
    return data;
  };
  if(c.hit && !c.fresh){ withInflight(key,fetcher); return c.val; }
  return withInflight(key,fetcher);
}

app.get("/scores/nba", async (req,res)=>serveSingle(req,res,"basketball",        L.NBA, seasonsCrossTriple()));
app.get("/scores/nfl", async (req,res)=>serveSingle(req,res,"american_football", L.NFL, seasonsNFL()));
app.get("/scores/nhl", async (req,res)=>serveSingle(req,res,"ice_hockey",        L.NHL, seasonsCrossTriple()));
app.get("/scores/baseball", async (req,res)=>serveSingle(req,res,"baseball",     L.MLB, seasonsCrossTriple()));

async function serveSingle(req,res,sport,leagueId,seasons){
  try{
    const n=Math.max(5, Math.min(10, parseInt(req.query.n||DEFAULT_COUNT,10)||DEFAULT_COUNT));
    const key=`OUT:${sport}:${leagueId}:${n}`;
    const items=await getBoardCached(key, ()=>buildSingle({sport,leagueId,seasons,n}), n);
    res.json(items.map(m=>formatMatch(m,sport)));
  }catch(e){ console.error(`${sport} error:`, e); res.status(500).json({error:"internal"}); }
}

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
