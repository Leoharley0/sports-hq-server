// server.js — v41 EPL-only (reconstructed): Finals→Live→Scheduled, calendar sweep (Fri–Mon), low-load, robust parsing.

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v41 (EPL-only: finals/live/season + Fri–Mon day-sweep)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

// Polyfill fetch (Node < 18)
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

/* ============================ Config ============================ */
const DEFAULT_COUNT = 10;

const L = { EPL: 4328, NBA: 4387, NFL: 4391, NHL: 4380 };

// How far ahead to look with the Fri–Mon sweep (in weeks) and how many days per week
const EPL_SWEEP_WEEKS = 16;             // ~4 months
const EPL_SWEEP_DOW   = [5,6,0,1];      // Fri, Sat, Sun, Mon (UTC day-of-week)

// Cache TTLs
const TTL = {
  LIVE:   15_000,
  NEXT:    5 * 60_000,
  SEASON:  2 * 60 * 60_000,
  PAST:   10 * 60_000,
  DAY:    25 * 60_000,
  OUT:     90_000,
};
const SWR_EXTRA = 5 * 60_000;

// Keys
const V2_KEY = process.env.TSDB_V2_KEY || "";
const V1_KEY = process.env.TSDB_V1_KEY || "";
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY missing (live may be limited)");
if (!V1_KEY) console.warn("ℹ️ TSDB_V1_KEY missing (using shared/test key)");

// Basic request helpers
const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const jitter=ms=>ms + Math.floor(Math.random()*(ms/3));

/* ============================ SWR cache + dedupe ============================ */
const cache=new Map(), inflight=new Map();
function getCache(k){
  const e=cache.get(k); if (!e) return {hit:false};
  const now=Date.now();
  if (now<=e.exp) return {hit:true, fresh:true,  val:e.val};
  if (now<=e.swr) return {hit:true, fresh:false, val:e.val};
  return {hit:false};
}
function setCache(k,val,ttl){ const now=Date.now(); cache.set(k,{val,exp:now+ttl,swr:now+ttl+SWR_EXTRA}); }
async function withInflight(k,fn){ if(inflight.has(k)) return inflight.get(k); const p=(async()=>{ try{return await fn();} finally{ inflight.delete(k);} })(); inflight.set(k,p); return p; }

/* ============================ Fetch wrappers ============================ */
async function fetchJsonRetry(url, extra={}, tries=4, baseDelay=650){
  let lastErr;
  for (let i=0;i<tries;i++){
    try{
      const res=await fetch(url,{headers:{...COMMON_HEADERS,...extra}});
      const txt=await res.text();
      if (res.status===429){
        const ra=Number(res.headers?.get("retry-after"))||0;
        const wait=jitter(ra?ra*1000:baseDelay*Math.pow(2,i));
        console.warn(`[429] wait ${wait}ms :: ${url}`); await sleep(wait); continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} | ${txt.slice(0,200)}`);
      return JSON.parse(txt);
    }catch(e){
      lastErr=e; const wait=jitter(baseDelay*Math.pow(2,i));
      console.warn(`[retry] ${e.message}; wait ${wait}ms :: ${url}`); await sleep(wait);
    }
  }
  console.error(`[FAIL] ${lastErr?.message} :: ${url}`);
  return null;
}
async function memoJson(url, ttl, extra={}){
  const key=`URL:${url}`;
  const c=getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const j=await fetchJsonRetry(url, extra); if (j) setCache(key,j,ttl); return j || c.val || null; };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

const V1 = p => `https://www.thesportsdb.com/api/v1/json/${V1_KEY||"3"}/${p}`;
async function v1NextLeague(id){ const j=await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(V1(`eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`), TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }
async function v1EventsDay(label, ymd){ const j=await memoJson(V1(`eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`), TTL.DAY); return Array.isArray(j?.events)?j.events:[]; }
async function v2Livescore(sport){
  const s=sport.replace(/_/g," ");
  const urls=[`https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
              `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`];
  const out=[]; for (const u of urls){ const j=await memoJson(u, TTL.LIVE, V2_KEY?{"X-API-KEY":V2_KEY}:{});
    if (Array.isArray(j?.livescore)) out.push(...j.livescore); }
  return out;
}

/* ============================ Time/status ============================ */
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
  if (m){ const Y=+m[1], M=+m[2]-1, D=+m[3]; return Date.UTC(Y,M,D,12,0,0); } // midday UTC
  return NaN;
}
function isTBA(t){ if(!t) return true; const s=String(t).trim().toLowerCase(); return !s||s==="tba"||s==="tbd"||s==="ns"||s.startsWith("00:00:00"); }
function eventMillis(m){
  const tryCombo=(d,t)=>{
    if(!d) return {ms:NaN,dateOnly:false,ymd:""};
    const ds=String(d).trim(); const ymd=ds.slice(0,10);
    if (isTBA(t)){ const base=parseFlexibleDate(ds); return {ms:base,dateOnly:true,ymd}; }
    const tt=String(t).trim().replace(/([+\-]\d{2})(\d{2})$/,"$1:$2");
    const iso=/[Zz]|[+\-]\d{2}:\d{2}$/.test(tt)?`${ds}T${tt}`:`${ds}T${tt}Z`;
    const msec=Date.parse(iso); return {ms:msec,dateOnly:false,ymd};
  };
  let r=tryCombo(m.dateEvent, m.strTime); if (Number.isFinite(r.ms)) return r;
  r=tryCombo(m.dateEventLocal||m.dateEvent, m.strTimeLocal||m.strTime); if (Number.isFinite(r.ms)) return r;
  let ms=parseFlexibleDate(m.strTimestampMS); if (Number.isFinite(ms)) return {ms,dateOnly:false,ymd:new Date(ms).toISOString().slice(0,10)};
  ms=parseFlexibleDate(m.strTimestamp);       if (Number.isFinite(ms)) return {ms,dateOnly:false,ymd:new Date(ms).toISOString().slice(0,10)};
  ms=parseFlexibleDate(m.strDate||m.date);    if (Number.isFinite(ms)) return {ms,dateOnly:false,ymd:new Date(ms).toISOString().slice(0,10)};
  return {ms:NaN,dateOnly:false,ymd:""};
}
function futureOK(ev, nowMs){
  const {ms,dateOnly,ymd}=eventMillis(ev);
  if (Number.isFinite(ms) && ms>=nowMs) return true;
  if (dateOnly){ const today=new Date(nowMs).toISOString().slice(0,10); return ymd>=today; }
  return false;
}
function isRecentFinal(m){ const raw=m.strStatus||m.strProgress||""; if(!isFinalWord(raw)) return false; const t=eventMillis(m).ms; return Number.isFinite(t)&&(Date.now()-t)<=FINAL_KEEP_MS; }
function computedStatus(m){ const s1=pickScore(m.intHomeScore??m.intHomeGoals), s2=pickScore(m.intAwayScore??m.intAwayGoals); return normalizeStatus(m,s1,s2); }
function pushUnique(arr,m){ const k=m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`; if (arr.some(x => (x.idEvent || `${x.strHomeTeam}|${x.strAwayTeam}|${x.dateEvent||x.dateEventLocal||""}`)===k)) return false; arr.push(m); return true; }
function sortForDisplay(a,b){ const R=s=>s==="Final"?0:s==="LIVE"?1:2; const sa=computedStatus(a), sb=computedStatus(b);
  if (R(sa)!==R(sb)) return R(sa)-R(sb);
  const ta=eventMillis(a).ms, tb=eventMillis(b).ms;
  const aBad=!Number.isFinite(ta), bBad=!Number.isFinite(tb);
  if (aBad && !bBad) return +1; if (!aBad && bBad) return -1;
  if (sa==="Final") return tb-ta; return ta-tb; }

/* ============================ Seasons helpers ============================ */
function guessSeasonCrossYear(){ const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1; const start=(m>=7)?y:y-1; return `${start}-${start+1}`; }
function seasonsSoccer(){ const c=guessSeasonCrossYear(); const y=(new Date()).getUTCFullYear(); return [c, `${y}`, `${y+1}`, `${y-1}`]; }

/* ============================ EPL calendar sweep ============================ */
function ymdAddDays(baseMs, days){ return new Date(baseMs + days*86400000).toISOString().slice(0,10); }
function nextDatesFriMon(weeks){
  const out=[]; const now=new Date(); const base=Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0,0,0);
  for (let w=0; w<weeks; w++){
    for (const dow of EPL_SWEEP_DOW){
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + w*7);
      // shift inside the week to the exact dow
      const cur = d.getUTCDay(); // 0..6
      const delta = (dow - cur + 7) % 7;
      const ymd = ymdAddDays(d.getTime(), delta);
      out.push(ymd);
    }
  }
  // dedupe + sort
  return Array.from(new Set(out)).sort();
}

/* ============================ Core EPL builder ============================ */
async function buildEPL(n){
  const finals=[], live=[], sched=[];
  const now=Date.now();

  // 1) Finals (recent)
  const past=await v1PastLeague(L.EPL);
  for (const m of (past||[])) if (isRecentFinal(m)) pushUnique(finals, m);
  finals.sort((a,b)=>eventMillis(b).ms - eventMillis(a).ms);

  // 2) Live
  const ls=await v2Livescore("soccer");
  for (const m of (ls||[])){
    const id=String(m.idLeague||"");
    const ok = id===String(L.EPL) ||
              ((m.strLeague||"").toLowerCase().includes("premier league") &&
               (m.strCountry||"").toLowerCase().includes("england"));
    if (ok && !isRecentFinal(m)) pushUnique(live, m);
  }

  // 3) Season calendars (current + simple neighbors)
  const seasons = seasonsSoccer();
  let seasonRaw=0, seasonFut=0;
  for (const s of seasons){
    const rows=await v1Season(L.EPL, s);
    seasonRaw += (rows?.length||0);
    const fut=(rows||[]).filter(e=>futureOK(e, now)).sort((a,b)=>eventMillis(a).ms - eventMillis(b).ms);
    seasonFut += fut.length;
    for (const m of fut){ if (finals.length+live.length+sched.length>=n) break; pushUnique(sched, m); }
    if (finals.length+live.length+sched.length>=n) break;
  }

  // 4) Fri–Mon day sweep (low number of calls; high EPL hit-rate)
  let calls=0, added=0, rawSeen=0;
  if (finals.length+live.length+sched.length < n){
    const ymds = nextDatesFriMon(EPL_SWEEP_WEEKS);
    for (const ymd of ymds){
      if (finals.length+live.length+sched.length>=n) break;
      const rows=await v1EventsDay("Soccer", ymd); calls++; rawSeen += (rows?.length||0);
      const fut=(rows||[])
        .filter(m => String(m.idLeague||"")===String(L.EPL) ||
                     ((m.strLeague||"").toLowerCase().includes("premier league") &&
                      (m.strCountry||"").toLowerCase().includes("england")))
        .filter(m => futureOK(m, now))
        .sort((a,b)=>eventMillis(a).ms - eventMillis(b).ms);
      for (const m of fut){ if (finals.length+live.length+sched.length>=n) break; if (pushUnique(sched, m)) added++; }
    }
    console.log(`[epl sweep] days=${ymds.length} calls=${calls} raw=${rawSeen} added=${added}`);
  }

  // 5) Next-league top-up
  if (finals.length+live.length+sched.length < n){
    const nxt=(await v1NextLeague(L.EPL)).filter(e=>futureOK(e, now)).sort((a,b)=>eventMillis(a).ms - eventMillis(b).ms);
    for (const m of nxt){ if (finals.length+live.length+sched.length>=n) break; pushUnique(sched, m); }
  }

  const out=[...finals, ...live, ...sched].sort(sortForDisplay).slice(0,n);
  console.log(`[EPL] F=${finals.length} L=${live.length} seasonRaw=${seasonRaw} seasonFut=${seasonFut} -> out=${out.length}`);
  return out;
}

/* ============================ Cache wrapper ============================ */
async function getCached(key, builder){
  const c=getCache(key); if (c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const data=await builder(); const full=Array.isArray(data)&&data.length>=DEFAULT_COUNT; setCache(key,data, full?TTL.OUT:8_000); return data; };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

/* ============================ Format ============================ */
function formatMatch(m){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"", away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=pickScore(m.intHomeScore??m.intHomeGoals), s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const status=normalizeStatus(m,s1,s2); const ms=eventMillis(m).ms;
  return { team1:home, team2:away, score1:s1===null?"N/A":String(s1), score2:s2===null?"N/A":String(s2),
           headline:`${home} vs ${away} - ${status}`, start:Number.isFinite(ms)?new Date(ms).toISOString():null };
}

/* ============================ Routes ============================ */
app.get("/scores/soccer", async (req,res)=>{
  try{
    const n=Math.max(5, Math.min(10, parseInt(req.query.n||DEFAULT_COUNT,10)||DEFAULT_COUNT));
    // bump key version when you deploy to force a rebuild: v41
    const rows = await getCached(`OUT:epl_v41:${n}`, () => buildEPL(n));
    console.log(`/scores/soccer -> ${Array.isArray(rows)?rows.length:0} items (n=${n})`);
    res.json((rows||[]).map(formatMatch));
  }catch(e){ console.error("soccer error:", e); res.status(500).json({error:"internal"}); }
});

// The other sports unchanged (these were already working well for you)
app.get("/scores/nba", async (req,res)=>serveSingle(req,res,"basketball",        L.NBA));
app.get("/scores/nfl", async (req,res)=>serveSingle(req,res,"american_football", L.NFL));
app.get("/scores/nhl", async (req,res)=>serveSingle(req,res,"ice_hockey",        L.NHL));

function seasonsDefault(){ const c=guessSeasonCrossYear(); return [c, `${+c.split("-")[0]+1}-${+c.split("-")[0]+2}`, `${+c.split("-")[0]-1}-${c.split("-")[0]}`]; }
function seasonsNFL(){ const y=(new Date()).getUTCFullYear(), c=guessSeasonCrossYear(); return [String(y),String(y+1),String(y-1),c]; }

async function buildSingle({ sport, leagueId, n }){
  const finals=[], live=[], sched=[]; const now=Date.now();

  const past=await v1PastLeague(leagueId);
  for (const m of (past||[])) if (isRecentFinal(m)) pushUnique(finals, m);
  finals.sort((a,b)=>eventMillis(b).ms - eventMillis(a).ms);

  const ls=await v2Livescore(sport);
  for (const m of (ls||[])) if (String(m.idLeague||"")===String(leagueId) && !isRecentFinal(m)) pushUnique(live, m);

  const seasons = sport==="american_football" ? seasonsNFL() : seasonsDefault();
  let seasonRaw=0, seasonFut=0;
  for (const s of seasons){
    const rows=await v1Season(leagueId, s);
    seasonRaw += (rows?.length||0);
    const fut=(rows||[]).filter(e=>futureOK(e, now)).sort((a,b)=>eventMillis(a).ms - eventMillis(b).ms);
    seasonFut += fut.length;
    for (const m of fut){ if (finals.length+live.length+sched.length>=n) break; pushUnique(sched, m); }
    if (finals.length+live.length+sched.length>=n) break;
  }
  if (finals.length+live.length+sched.length < n){
    const nxt=(await v1NextLeague(leagueId)).filter(e=>futureOK(e, now)).sort((a,b)=>eventMillis(a).ms - eventMillis(b).ms);
    for (const m of nxt){ if (finals.length+live.length+sched.length>=n) break; pushUnique(sched, m); }
  }
  const out=[...finals, ...live, ...sched].sort(sortForDisplay).slice(0,n);
  console.log(`[${sport}:${leagueId}] F=${finals.length} L=${live.length} seasonRaw=${seasonRaw} seasonFut=${seasonFut} -> out=${out.length}`);
  return out;
}

async function serveSingle(req,res,sport,leagueId){
  try{
    const n=Math.max(5, Math.min(10, parseInt(req.query.n||DEFAULT_COUNT,10)||DEFAULT_COUNT));
    const rows=await getCached(`OUT:${sport}:${leagueId}:v41:${n}`, ()=>buildSingle({sport,leagueId,n}));
    console.log(`/scores/${sport} -> ${Array.isArray(rows)?rows.length:0} items (n=${n})`);
    res.json((rows||[]).map(formatMatch));
  }catch(e){ console.error(`${sport} error:`, e); res.status(500).json({error:"internal"}); }
}

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
