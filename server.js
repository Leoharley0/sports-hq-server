// server.js — v31: fix day-fill duplicates, smarter league match on 'day', longer runway
// - pushUnique() now returns true/false (count only real additions)
// - dayFill uses leagueMatchDay() to catch EPL/NFL names on eventsday
// - dayFill expanded (maxDays 56, maxCalls 24)

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v31 (day dedupe + day league-match + longer runway)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ===== ENV =====
const V2_KEY = process.env.TSDB_V2_KEY || "";
const V1_KEY = process.env.TSDB_V1_KEY || "";
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY missing (live may be limited)");
if (!V1_KEY) console.warn("ℹ️ TSDB_V1_KEY missing; using shared/test key");

// ===== CONFIG/CACHE =====
const DEFAULT_COUNT = 10;
const TTL = { LIVE:15_000, NEXT:5*60_000, SEASON:2*60*60_000, PAST:10*60_000, DAY:30*60_000, OUT:90_000 };
const SWR_EXTRA = 5*60_000;

const cache = new Map(), inflight = new Map();
function getCache(k){ const e=cache.get(k); if(!e) return {hit:false}; const now=Date.now();
  if (now<=e.exp) return {hit:true,fresh:true,val:e.val};
  if (now<=e.swr) return {hit:true,fresh:false,val:e.val};
  return {hit:false};
}
function setCache(k,val,ttl){ const now=Date.now(); cache.set(k,{val,exp:now+ttl,swr:now+ttl+SWR_EXTRA}); }
async function withInflight(k,fn){ if(inflight.has(k)) return inflight.get(k);
  const p=(async()=>{ try{ return await fn(); } finally{ inflight.delete(k); } })(); inflight.set(k,p); return p; }

const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
const jitter= ms=>ms+Math.floor(Math.random()*(ms/3));
async function fetchJsonRetry(url, extra={}, tries=4, baseDelay=650){
  let lastErr;
  for (let i=0;i<tries;i++){
    try{
      const res=await fetch(url,{headers:{...COMMON_HEADERS,...extra}});
      const txt=await res.text();
      if (res.status===429){ const ra=Number(res.headers?.get("retry-after"))||0; const wait=jitter(ra?ra*1000:baseDelay*Math.pow(2,i));
        console.warn(`[429] wait ${wait}ms :: ${url}`); await sleep(wait); continue; }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} | ${txt.slice(0,200)}`);
      return JSON.parse(txt);
    }catch(e){ lastErr=e; const wait=jitter(baseDelay*Math.pow(2,i)); console.warn(`[retry] ${e.message}; wait ${wait}ms :: ${url}`); await sleep(wait); }
  }
  console.error(`[FAIL] ${lastErr?.message} :: ${url}`); return null;
}
async function memoJson(url, ttl, extra={}) {
  const key=`URL:${url}`; const c=getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const j=await fetchJsonRetry(url, extra); if (j) setCache(key,j,ttl); return j || c.val || null; };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ===== time helpers =====
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
const FINAL_KEEP_MS=15*60*1000;
function isRecentFinal(m){ const raw=m.strStatus||m.strProgress||""; if(!isFinalWord(raw)) return false; const t=eventMillis(m).ms; return Number.isFinite(t)&&(Date.now()-t)<=FINAL_KEEP_MS; }

// robust parsing
function parseFlexibleDate(str){
  if (str==null) return NaN;
  if (typeof str!=="string"){ const n=Number(str); return Number.isFinite(n)?(n>1e12?n:n*1000):NaN; }
  const s=str.trim(); if(!s) return NaN;
  if (/^\d{13}$/.test(s)) return +s;
  if (/^\d{10}$/.test(s)) return +s*1000;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(:\d{2})?/.test(s)){
    let w=s.replace(" ","T").replace(/([+\-]\d{2})(\d{2})$/,"$1:$2");
    if (!/[Zz]|[+\-]\d{2}:\d{2}$/.test(w)) w+="Z";
    const ms=Date.parse(w); if (Number.isFinite(ms)) return ms;
  }
  const direct=Date.parse(s); if (Number.isFinite(direct)) return direct;
  const m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m){ const Y=+m[1], M=+m[2]-1, D=+m[3]; return Date.UTC(Y,M,D,12,0,0); }
  return NaN;
}
function isTBA(t){ if(!t) return true; const s=String(t).trim().toLowerCase(); return !s||s==="tba"||s==="tbd"||s==="ns"||s.startsWith("00:00:00"); }
function eventMillis(m){
  let ms=parseFlexibleDate(m.strTimestampMS); if (Number.isFinite(ms)) return {ms,dateOnly:false,ymd:new Date(ms).toISOString().slice(0,10)};
  ms=parseFlexibleDate(m.strTimestamp);       if (Number.isFinite(ms)) return {ms,dateOnly:false,ymd:new Date(ms).toISOString().slice(0,10)};
  const tryCombo=(d,t)=>{
    if(!d) return {ms:NaN,dateOnly:false,ymd:""};
    const ds=String(d).trim(); const ymd=ds.slice(0,10);
    if (isTBA(t)){ const base=parseFlexibleDate(ds); return {ms:base,dateOnly:true,ymd}; }
    const tt=String(t).trim().replace(/([+\-]\d{2})(\d{2})$/,"$1:$2");
    const iso=/[Zz]|[+\-]\d{2}:\d{2}$/.test(tt)?`${ds}T${tt}`:`${ds}T${tt}Z`;
    const msec=Date.parse(iso); return {ms:msec,dateOnly:false,ymd};
  };
  for (const [d,t] of [[m.dateEvent,m.strTime],[m.dateEventLocal,m.strTimeLocal],[m.dateEvent,null],[m.dateEventLocal,null]]){ const r=tryCombo(d,t); if (Number.isFinite(r.ms)) return r; }
  ms=parseFlexibleDate(m.strDate); if (Number.isFinite(ms)) return {ms,dateOnly:false,ymd:new Date(ms).toISOString().slice(0,10)};
  ms=parseFlexibleDate(m.date);    if (Number.isFinite(ms)) return {ms,dateOnly:false,ymd:new Date(ms).toISOString().slice(0,10)};
  return {ms:NaN,dateOnly:false,ymd:""};
}
function futureOK(ev, nowMs){
  const {ms,dateOnly,ymd}=eventMillis(ev);
  if (Number.isFinite(ms) && ms>=nowMs) return true;
  if (dateOnly){ const today=new Date(nowMs).toISOString().slice(0,10); return ymd>=today; }
  return false;
}

function computedStatus(m){ const s1=pickScore(m.intHomeScore??m.intHomeGoals), s2=pickScore(m.intAwayScore??m.intAwayGoals); return normalizeStatus(m,s1,s2); }

// return true if added
function pushUnique(arr,m){
  const k = m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`;
  if (arr.some(x => (x.idEvent || `${x.strHomeTeam}|${x.strAwayTeam}|${x.dateEvent||x.dateEventLocal||""}`) === k)) return false;
  arr.push(m); return true;
}
function sortForDisplay(a,b){
  const R=s=>s==="Final"?0:s==="LIVE"?1:2;
  const sa=computedStatus(a), sb=computedStatus(b);
  if (R(sa)!==R(sb)) return R(sa)-R(sb);
  const ta=eventMillis(a).ms, tb=eventMillis(b).ms;
  const aBad=!Number.isFinite(ta), bBad=!Number.isFinite(tb);
  if (aBad && !bBad) return +1; if (!aBad && bBad) return -1;
  if (sa==="Final") return tb-ta; return ta-tb;
}

// ===== TSDB wrappers =====
async function v2Livescore(sport){
  const s=sport.replace(/_/g," ");
  const urls=[
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out=[]; for (const u of urls){ const j=await memoJson(u, TTL.LIVE, V2_KEY?{"X-API-KEY":V2_KEY}:{});
    if (Array.isArray(j?.livescore)) out.push(...j.livescore);
  } return out;
}
const V1 = p => `https://www.thesportsdb.com/api/v1/json/${V1_KEY||"3"}/${p}`;
async function v1NextLeague(id){ const j=await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(V1(`eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`), TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }
const SPORT_LABEL={ soccer:"Soccer", basketball:"Basketball", american_football:"American Football", ice_hockey:"Ice Hockey" };
async function v1EventsDay(sport, ymd){ const label=SPORT_LABEL[sport]||sport; const j=await memoJson(V1(`eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`), TTL.DAY); return Array.isArray(j?.events)?j.events:[]; }

// ===== seasons & leagues =====
function guessSeasonCrossYear(){ const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1; const start=(m>=7)?y:y-1; return `${start}-${start+1}`; }
function nextCross(s){ const a=parseInt(s.split("-")[0],10); return `${a+1}-${a+2}`; }
function prevCross(s){ const a=parseInt(s.split("-")[0],10); return `${a-1}-${a}`; }
function seasonsSoccer(){ const c=guessSeasonCrossYear(), y=(new Date()).getUTCFullYear(); return [c, nextCross(c), prevCross(c), String(y), String(y+1), String(y-1)]; }
function seasonsNFL(){ const y=(new Date()).getUTCFullYear(), c=guessSeasonCrossYear(); return [String(y), String(y+1), String(y-1), c, nextCross(c), prevCross(c)]; }
function seasonsDefault(){ const c=guessSeasonCrossYear(); return [c, nextCross(c), prevCross(c)]; }

const L = { EPL:4328, NBA:4387, NFL:4391, NHL:4380 };

// ===== formatting =====
function formatMatch(m){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"", away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=pickScore(m.intHomeScore??m.intHomeGoals), s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const status=normalizeStatus(m,s1,s2); const ms=eventMillis(m).ms;
  return { team1:home, team2:away, score1:s1===null?"N/A":String(s1), score2:s2===null?"N/A":String(s2),
           headline:`${home} vs ${away} - ${status}`, start:Number.isFinite(ms)?new Date(ms).toISOString():null };
}

// ===== season rescue (date-only fixtures)
function rescueSeasonFuture(rows, nowMs){
  if (!Array.isArray(rows)||rows.length===0) return [];
  const today=new Date(nowMs).toISOString().slice(0,10);
  const out=[];
  for (const m of rows){
    const d=(m.dateEventLocal||m.dateEvent||"").slice(0,10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d>=today){
      const [Y,M,D]=d.split("-").map(Number);
      m.__rescuedMS=Date.UTC(Y,M-1,D,12,0,0);
      out.push(m);
    }
  }
  out.sort((a,b)=>(a.__rescuedMS||0)-(b.__rescuedMS||0));
  return out;
}

// ===== league match on 'day' (name-safe)
function leagueMatchDay(m, leagueId, sport){
  const idOk = String(m.idLeague||"") === String(leagueId);
  if (idOk) return true;
  const name = (m.strLeague||"").toLowerCase();
  if (sport==="soccer"){
    // Accept “Premier League”, but not PL2, Cups, Shield, etc.
    if (name.includes("premier league") && !name.includes("2") && !name.includes("cup") && !name.includes("shield")) return true;
    return false;
  }
  if (sport==="american_football"){
    if (name.includes("nfl") || name.includes("national football league")) return true;
    return false;
  }
  return idOk;
}

// ===== DAY FILL (dedup-aware, wider window)
async function dayFill({ sport, leagueId, out, need, maxDays=56, maxCalls=24 }){
  const now=Date.now(), today=new Date();
  let calls=0, added=0;
  for (let d=0; d<=maxDays && added<need; d++){
    if (calls>=maxCalls) break;
    const ymd=new Date(today.getTime()+d*86400000).toISOString().slice(0,10);
    const rows=await v1EventsDay(sport, ymd); calls++;
    const fut=(rows||[])
      .filter(m=>leagueMatchDay(m, leagueId, sport))
      .filter(m=>futureOK(m, now))
      .sort((a,b)=>eventMillis(a).ms - eventMillis(b).ms);
    for (const m of fut){
      if (added>=need) break;
      if (pushUnique(out, m)) added++;
    }
  }
  console.log(`[dayfill ${sport}:${leagueId}] +${added}/${need} (days<=${Math.min(maxDays,calls)})`);
}

// ===== unified builder =====
async function buildSingle({ sport, leagueId, seasons, n }){
  const now=Date.now(); const finals=[], live=[], sched=[];

  const past=await v1PastLeague(leagueId);
  for (const m of (past||[])) if (isRecentFinal(m)) pushUnique(finals, m);
  finals.sort((a,b)=>eventMillis(b).ms - eventMillis(a).ms);

  const ls=await v2Livescore(sport);
  for (const m of (ls||[])) if (String(m.idLeague||"")===String(leagueId) && !isRecentFinal(m)) pushUnique(live, m);

  const next=await v1NextLeague(leagueId);
  const nextFut=(next||[]).filter(e=>futureOK(e, now)).sort((a,b)=>eventMillis(a).ms - eventMillis(b).ms);
  for (const m of nextFut){ if (finals.length+live.length+sched.length>=n) break; pushUnique(sched, m); }

  let seasonRawTotal=0, seasonFutTotal=0;
  for (const s of seasons){
    if (finals.length+live.length+sched.length>=n) break;
    const rows=await v1Season(leagueId, s);
    const fut=(rows||[]).filter(e=>futureOK(e, now)).sort((a,b)=>eventMillis(a).ms - eventMillis(b).ms);
    seasonRawTotal += (rows||[]).length; seasonFutTotal += fut.length;
    for (const m of fut){ if (finals.length+live.length+sched.length>=n) break; pushUnique(sched, m); }
  }

  if (finals.length+live.length+sched.length<n && seasonRawTotal>seasonFutTotal){
    for (const s of seasons){
      if (finals.length+live.length+sched.length>=n) break;
      const rows=await v1Season(leagueId, s);
      const rescued=rescueSeasonFuture(rows, now);
      for (const m of rescued){ if (finals.length+live.length+sched.length>=n) break; pushUnique(sched, m); }
    }
  }

  const have=finals.length+live.length+sched.length;
  if (have<n){
    await dayFill({ sport, leagueId, out:sched, need:n-have, maxDays:56, maxCalls:24 });
  }

  const out=[...finals, ...live, ...sched].sort(sortForDisplay).slice(0,n);
  console.log(`[debug ${sport}:${leagueId}] F=${finals.length} L=${live.length} nextFut=${nextFut.length} seasonRaw=${seasonRawTotal} seasonFut=${seasonFutTotal} -> out=${out.length}`);
  return out;
}

// ===== cache wrapper =====
async function getBoardCached(key, builder){
  const c=getCache(key); if (c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const data=await builder(); const full=Array.isArray(data)&&data.length>=DEFAULT_COUNT; setCache(key,data, full?TTL.OUT:8_000); return data; };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ===== routes =====
app.get("/scores/soccer", async (req,res)=>{
  try{
    const n=Math.max(5, Math.min(10, parseInt(req.query.n||DEFAULT_COUNT,10)||DEFAULT_COUNT));
    const items=await getBoardCached(`OUT:soccer_epl_v31:${n}`, () =>
      buildSingle({ sport:"soccer", leagueId:L.EPL, seasons:seasonsSoccer(), n })
    );
    res.json(items.map(formatMatch));
  }catch(e){ console.error("soccer error:", e); res.status(500).json({error:"internal"}); }
});
app.get("/scores/nfl", async (req,res)=>serveSingle(req,res,"american_football", L.NFL, seasonsNFL()));
app.get("/scores/nba", async (req,res)=>serveSingle(req,res,"basketball",        L.NBA, seasonsDefault()));
app.get("/scores/nhl", async (req,res)=>serveSingle(req,res,"ice_hockey",        L.NHL, seasonsDefault()));
// legacy aliases
app.get("/scores/american_football", (req,res)=>serveSingle(req,res,"american_football", L.NFL, seasonsNFL()));
app.get("/scores/basketball",        (req,res)=>serveSingle(req,res,"basketball",        L.NBA, seasonsDefault()));

async function serveSingle(req,res,sport,leagueId,seasons){
  try{
    const n=Math.max(5, Math.min(10, parseInt(req.query.n||DEFAULT_COUNT,10)||DEFAULT_COUNT));
    const items=await getBoardCached(`OUT:${sport}:${leagueId}:v31:${n}`, () =>
      buildSingle({ sport, leagueId, seasons, n })
    );
    res.json(items.map(formatMatch));
  }catch(e){ console.error(`${sport} error:`, e); res.status(500).json({error:"internal"}); }
}

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
