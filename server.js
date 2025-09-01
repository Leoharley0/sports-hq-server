// server.js — v18F (EPL fix: accept date-only/TBA fixtures as future)
// Order: Finals (≤15m) → Live → Scheduled. SWR cache + throttled day scan.

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v18F (TBA date-only accepted + trace)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ===== KEYS =====
const V2_KEY = process.env.TSDB_V2_KEY || "";
const V1_KEY = process.env.TSDB_V1_KEY || "3";
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY missing (live limited)");
if (!V1_KEY || V1_KEY === "3") console.warn("ℹ️ TSDB_V1_KEY not set; using shared key");

// ===== CONFIG =====
const DEFAULT_COUNT = 10;
const TTL = { LIVE:15_000, NEXT:5*60_000, SEASON:6*60*60_000, DAY:30*60_000, PAST:10*60_000, OUT:60_000 };
const SWR_EXTRA = 5 * 60_000;

// Throttled day scan
const DAY_TOKENS_MAX = 80;
const DAY_TOKENS_REFILL_MS = 10_000;
let DAY_TOKENS = DAY_TOKENS_MAX;
setInterval(() => { DAY_TOKENS = Math.min(DAY_TOKENS_MAX, DAY_TOKENS + 4); }, DAY_TOKENS_REFILL_MS);

// ===== SWR cache & inflight =====
const cache = new Map();
const inflight = new Map();
function getCache(k){ const e=cache.get(k); if(!e) return {hit:false}; const now=Date.now();
  if(now<=e.exp) return {hit:true,fresh:true,val:e.val};
  if(now<=e.swr) return {hit:true,fresh:false,val:e.val};
  return {hit:false};
}
function setCache(k,val,ttl){ const now=Date.now(); cache.set(k,{val,exp:now+ttl,swr:now+ttl+SWR_EXTRA}); }
async function withInflight(k,fn){ if(inflight.has(k)) return inflight.get(k); const p=(async()=>{try{return await fn();}finally{inflight.delete(k);}})(); inflight.set(k,p); return p; }

// ===== fetch with light tracing =====
const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const jitter = ms => ms + Math.floor(Math.random()*(ms/3));
const LAST = [];
function trace(obj){ LAST.push({t:Date.now(),...obj}); if(LAST.length>80) LAST.shift(); }

async function fetchJsonRetry(url, extra={}, tries=4, base=650){
  let lastS = 0, lastErr = "";
  for(let i=0;i<tries;i++){
    try{
      const res = await fetch(url,{headers:{...COMMON_HEADERS,...extra}});
      lastS = res.status;
      const txt = await res.text();
      if(res.status===429){
        const ra = Number(res.headers?.get("retry-after"))||0;
        const wait = jitter(ra?ra*1000:base*Math.pow(2,i));
        trace({url, s:429, wait});
        await sleep(wait); continue;
      }
      if(!res.ok){ trace({url, s:res.status, note:txt.slice(0,80)}); throw new Error(`${res.status}`); }
      trace({url, s:res.status});
      return JSON.parse(txt);
    }catch(e){
      lastErr = e.message||"err";
      const wait = jitter(base*Math.pow(2,i));
      trace({url, s:lastS||-1, err:lastErr, wait});
      await sleep(wait);
    }
  }
  trace({url, s:lastS||-1, fail:true});
  return null;
}
async function memoJson(url, ttl, extra={}){
  const k=`URL:${url}`; const c=getCache(k);
  if(c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const j=await fetchJsonRetry(url,extra); if(j) setCache(k,j,ttl); return j||c.val||null; };
  if(c.hit && !c.fresh){ withInflight(k,fetcher); return c.val; }
  return withInflight(k,fetcher);
}

// ===== time & status (TBA date-only aware) =====
function isTBA(s){ if(!s) return true; const t=String(s).trim().toLowerCase(); return !t||t==="tba"||t==="tbd"||t==="ns"||t==="00:00:00"||t==="00:00:00z"; }
function eventMillis(m){
  const mk = (d,t)=>{
    if(!d) return {ms:NaN,dateOnly:false,ymd:""};
    const ymd = String(d).slice(0,10);
    if(isTBA(t)) return { ms: Date.parse(`${ymd}T12:00:00Z`), dateOnly:true, ymd };
    const tt = String(t).trim().replace(/([+\-]\d{2})(\d{2})$/,"$1:$2");
    const hasTZ = /[Zz]|[+\-]\d{2}:\d{2}$/.test(tt);
    const ms = Date.parse(`${ymd}T${hasTZ?tt:`${tt}Z`}`);
    return {ms, dateOnly:false, ymd};
  };
  let r = mk(m.dateEvent, m.strTime); if(Number.isFinite(r.ms)) return r;
  r = mk(m.dateEventLocal||m.dateEvent, m.strTimeLocal||m.strTime); if(Number.isFinite(r.ms)) return r;
  const num = v => (v==null?NaN:(typeof v==="number"?v:(/^\d{13}$/.test(v)?+v:/^\d{10}$/.test(v)?+v*1000:NaN)));
  const ms = num(m.strTimestampMS) || num(m.strTimestamp);
  if(Number.isFinite(ms)) return {ms,dateOnly:false,ymd:new Date(ms).toISOString().slice(0,10)};
  if(m.dateEvent){ const ymd=String(m.dateEvent).slice(0,10); return {ms:Date.parse(`${ymd}T12:00:00Z`),dateOnly:true,ymd}; }
  return {ms:NaN,dateOnly:false,ymd:""};
}
function futureOK(m, now){
  const {ms,dateOnly,ymd} = eventMillis(m);
  if(Number.isFinite(ms) && ms>=now) return true;
  if(dateOnly){ const today=new Date(now).toISOString().slice(0,10); return ymd>=today; }
  return false;
}
function isFinalWord(s=""){ s=(s+"").toLowerCase(); return s.includes("final")||s==="ft"||s.includes("full time"); }
function isLiveWord(s=""){ s=(s+"").toLowerCase(); return s.includes("live")||s.includes("in play")||s.includes("half")||s==="ht"||/^q\d/.test(s)||s.includes("quarter")||s.includes("ot"); }
function statusOf(m){
  const raw=String(m.strStatus||m.strProgress||"").trim();
  const hasScore=(m.intHomeGoals!=null)||(m.intAwayGoals!=null)||(m.intHomeScore!=null)||(m.intAwayScore!=null);
  if(isFinalWord(raw)) return "Final";
  if(isLiveWord(raw))  return hasScore ? "LIVE" : "Scheduled";
  if(!raw||raw==="NS"||raw.toLowerCase()==="scheduled"||raw.toLowerCase()==="preview") return "Scheduled";
  return hasScore ? raw : "Scheduled";
}
function matchKey(m){ return m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`; }
function pushUnique(arr,m){ const k=matchKey(m); if(!arr.some(x=>matchKey(x)===k)) arr.push(m); }
function sortForDisplay(a,b){
  const rank = s => s==="Final"?0 : s==="LIVE"?1 : 2;
  const sa=statusOf(a), sb=statusOf(b);
  if(rank(sa)!==rank(sb)) return rank(sa)-rank(sb);
  const ta=eventMillis(a).ms, tb=eventMillis(b).ms;
  const aBad=!Number.isFinite(ta), bBad=!Number.isFinite(tb);
  if(aBad&&!bBad) return +1; if(!aBad&&bBad) return -1;
  if(sa==="Final") return tb-ta; else return ta-tb;
}

// ===== TSDB wrappers =====
const V1 = p => `https://www.thesportsdb.com/api/v1/json/${V1_KEY}/${p}`;
const SPORT_LABEL={ soccer:"Soccer", basketball:"Basketball", american_football:"American Football", ice_hockey:"Ice Hockey" };

async function v2Livescore(sport){
  const s=sport.replace(/_/g," ");
  const urls=[
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out=[]; for(const u of urls){ const j=await memoJson(u, TTL.LIVE, V2_KEY?{"X-API-KEY":V2_KEY}:{});
    if(j?.livescore?.length) out.push(...j.livescore);
  } return out;
}
async function v1NextLeague(id){ const j=await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(V1(`eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`), TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }
async function v1EventsDay(sport,ymd){ const label=SPORT_LABEL[sport]||sport; const j=await memoJson(V1(`eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`), TTL.DAY); return Array.isArray(j?.events)?j.events:[]; }

// ===== seasons =====
function guessCross(){ const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1; const s=(m>=7)?y:y-1; return `${s}-${s+1}`; }
function seasonsCrossTriple(){ const c=guessCross(); const prev=`${parseInt(c)-1}-${parseInt(c)}`; const next=`${parseInt(c)+1}-${parseInt(c)+2}`; return [c, next, prev]; }
function seasonsNFL(){ const y=(new Date()).getUTCFullYear(); const c=guessCross(); return [String(y), String(y+1), c, `${parseInt(c)-1}-${parseInt(c)}`]; }

// ===== leagues =====
const L = { EPL:4328, NBA:4387, NFL:4391, NHL:4380 };

// ===== formatting =====
function formatMatch(m){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"";
  const away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=m.intHomeScore??m.intHomeGoals; const s2=m.intAwayScore??m.intAwayGoals;
  const status=statusOf(m);
  const ms=eventMillis(m).ms;
  return { team1:home, team2:away,
    score1:(s1==null?"N/A":String(s1)), score2:(s2==null?"N/A":String(s2)),
    headline:`${home} vs ${away} - ${status}`,
    start:Number.isFinite(ms)?new Date(ms).toISOString():null
  };
}

// ===== helpers =====
async function fillFromSeasons(out, leagueId, seasons, n){
  const now=Date.now();
  for(const s of seasons){
    const rows = await v1Season(leagueId, s);
    const fut = (rows||[]).filter(m=>futureOK(m,now)).sort((a,b)=>eventMillis(a).ms - eventMillis(b).ms);
    for(const m of fut){ if(out.length>=n) break; pushUnique(out,m); }
    if(out.length>=n) break;
  }
}
async function dayFill(out, sport, leagueId, n, horizonDays=21){
  let short = n - out.length; if (short<=0) return {used:0, kept:0};
  let used=0, kept=0; const now=Date.now();
  const today=new Date();
  for(let d=0; d<horizonDays && out.length<n; d++){
    if(DAY_TOKENS<=0) break;
    DAY_TOKENS--; used++;
    const ymd=new Date(today.getTime()+d*86400000).toISOString().slice(0,10);
    const rows=await v1EventsDay(sport, ymd);
    for(const m of (rows||[])){
      if(String(m.idLeague||"")!==String(leagueId)) continue;
      if(!futureOK(m,now)) continue;
      pushUnique(out,m); kept++;
      if(out.length>=n) break;
    }
  }
  return {used, kept};
}

// ===== core boards =====
async function buildSingle({ sport, leagueId, seasons, n }){
  const finals=[], live=[], sched=[];
  const now=Date.now();

  // Finals recent (<=15m)
  const recentMs = 15*60*1000;
  const past = await v1PastLeague(leagueId);
  for(const m of (past||[])){ if(isFinalWord(m.strStatus||m.strProgress||"")){ const t=eventMillis(m).ms; if(Number.isFinite(t)&&now-t<=recentMs) pushUnique(finals,m); } }
  finals.sort((a,b)=>eventMillis(b).ms - eventMillis(a).ms);

  // Live
  const ls = await v2Livescore(sport);
  for(const m of (ls||[])){ if(String(m.idLeague||"")===String(leagueId) && !isFinalWord(m.strStatus||m.strProgress||"")) pushUnique(live,m); }

  // Scheduled
  await fillFromSeasons(sched, leagueId, seasons, n-(finals.length+live.length));
  if(finals.length+live.length+sched.length < n){
    const next = (await v1NextLeague(leagueId)).sort((a,b)=>eventMillis(a).ms - eventMillis(b).ms);
    const now2=Date.now();
    for(const m of next){ if(finals.length+live.length+sched.length>=n) break; if(futureOK(m,now2)) pushUnique(sched,m); }
  }
  if(finals.length+live.length+sched.length < n){
    await dayFill(sched, sport, leagueId, n-(finals.length+live.length), 21);
  }

  const out = [...finals, ...live, ...sched].sort(sortForDisplay).slice(0,n);
  console.log(`[${sport}:${leagueId}] F=${finals.length} L=${live.length} S=${sched.length} -> out=${out.length}`);
  return out;
}

// ===== cached wrapper =====
async function getBoardCached(key, builder){
  const c=getCache(key);
  if(c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const data=await builder(); setCache(key,data,TTL.OUT); return data; };
  if(c.hit && !c.fresh){ withInflight(key,fetcher); return c.val; }
  return withInflight(key,fetcher);
}

// ===== routes =====
app.get("/scores/soccer", async (req,res)=>serveSingle(req,res,"soccer", L.EPL, seasonsCrossTriple()));
app.get("/scores/nba",    async (req,res)=>serveSingle(req,res,"basketball",        L.NBA, seasonsCrossTriple()));
app.get("/scores/nfl",    async (req,res)=>serveSingle(req,res,"american_football", L.NFL, seasonsNFL()));
app.get("/scores/nhl",    async (req,res)=>serveSingle(req,res,"ice_hockey",        L.NHL, seasonsCrossTriple()));

async function serveSingle(req,res,sport,leagueId,seasons){
  try{
    const nocache = "nocache" in req.query;
    const n = Math.max(5, Math.min(10, parseInt(req.query.n||DEFAULT_COUNT,10)||DEFAULT_COUNT));
    const key = `OUT:${sport}:${leagueId}:${n}`;
    if(nocache) cache.delete(key);
    const items = await getBoardCached(key, () => buildSingle({sport,leagueId,seasons,n}));
    res.json(items.map(formatMatch));
  }catch(e){ console.error(`${sport} error`, e); res.status(500).json({error:"internal"}); }
}

// ===== tiny debug =====
app.get("/debug/lastcalls", (_,res)=>res.json({ build: BUILD, last: LAST }));

app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
