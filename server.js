// server.js — v8: retry/backoff + multi-league SOCCER (EPL/BL/LL/L1) + deeper fills
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v8 (soccer multi-league + retry/backoff)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ENV
const V2_KEY = process.env.TSDB_V2_KEY || "";
const V1_KEY = process.env.TSDB_V1_KEY || "";
if (!V2_KEY) console.error("❌ Missing TSDB_V2_KEY");
if (!V1_KEY) console.warn("⚠️ Missing TSDB_V1_KEY");

const DEFAULT_COUNT = 12;
const TTL = { LIVE:15e3, NEXT:5*60e3, SEASON:3*60*60e3, DAY:30*60e3, PAST:10*60e3, OUT:25e3 };

const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };

// ------------ cache ------------
const cache = new Map();
const getC = k => { const v = cache.get(k); if (v && v.exp>Date.now()) return v.val; if (v) cache.delete(k); return null; };
const setC = (k,val,ttl) => cache.set(k,{val,exp:Date.now()+ttl});

// ------------ fetch + retry ------------
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function fetchJsonRetry(url, extra={}, tries=4, baseDelay=600){
  let err; for (let i=0;i<tries;i++){
    try{
      const res = await fetch(url,{headers:{...COMMON_HEADERS,...extra}});
      const txt = await res.text();
      if (res.status===429){
        const ra=Number(res.headers?.get("retry-after"))||0;
        const wait= ra? ra*1000 : baseDelay*Math.pow(2,i);
        console.warn(`[retry 429] ${url} -> wait ${wait}ms (try ${i+1}/${tries})`);
        await sleep(wait); continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} | ${txt.slice(0,180)}`);
      return JSON.parse(txt);
    }catch(e){ err=e; const wait=baseDelay*Math.pow(2,i); console.warn(`[retry err] ${url} -> ${e.message}; wait ${wait}ms`); await sleep(wait); }
  }
  console.error(`[fetch FAIL] ${err?.message} :: ${url}`); return null;
}
async function memoJson(url, ttl, extra={}){
  const k=`URL:${url}`; const hit=getC(k); if (hit) return hit;
  const j=await fetchJsonRetry(url, extra); if (j) setC(k,j,ttl); return j;
}

// ------------ time/status helpers ------------
function cleanTime(t){ if(!t) return "00:00:00"; const s=String(t).trim(); return (/^tba$|^tbd$/i.test(s))?"00:00:00":s; }
function toMillis(d, t){ if(!d) return NaN; const tt=cleanTime(t); const hasTZ=/[zZ]$|[+\-]\d\d:?\d\d$/.test(tt); const ms=Date.parse(`${d}T${tt}${hasTZ?"":"Z"}`); return Number.isNaN(ms)?NaN:ms; }
function eventMillis(m){
  let ms=toMillis(m.dateEvent, m.strTime); if (!Number.isNaN(ms)) return ms;
  ms=toMillis(m.dateEventLocal||m.dateEvent, m.strTimeLocal||m.strTime); if (!Number.isNaN(ms)) return ms;
  if (m.strTimestampMS){ const n=+m.strTimestampMS; if (!Number.isNaN(n)) return n; }
  if (m.strTimestamp){ const n=+m.strTimestamp*1000; if (!Number.isNaN(n)) return n; }
  if (m.dateEvent){ ms=toMillis(m.dateEvent,"00:00:00Z"); if (!Number.isNaN(ms)) return ms; }
  if (m.dateEventLocal){ ms=toMillis(m.dateEventLocal,"00:00:00Z"); if (!Number.isNaN(ms)) return ms; }
  return NaN;
}
function pickScore(v){ return (v===undefined||v===null||v===""||v==="N/A")?null:v; }
function isLiveWord(s=""){ s=(s+"").toLowerCase(); return s.includes("live")||s.includes("in play")||/^q\d/.test(s)||s.includes("quarter")||s.includes("ot")||s.includes("overtime")||s.includes("half")||s==="ht"; }
function isFinalWord(s=""){ s=(s+"").toLowerCase(); return s.includes("final")||s==="ft"||s.includes("full time"); }
function normalizeStatus(m,s1,s2){
  const raw=String(m.strStatus||m.strProgress||"").trim(); const hasScore=(s1!==null)||(s2!==null);
  if (isFinalWord(raw)) return "Final";
  if (isLiveWord(raw))  return hasScore ? "LIVE" : "Scheduled";
  if (!raw||raw==="NS"||raw.toLowerCase()==="scheduled"||raw.toLowerCase()==="preview") return "Scheduled";
  return hasScore ? raw : "Scheduled";
}
const FINAL_KEEP_MS = 15*60*1000;
function isOldFinal(m){ const raw=m.strStatus||m.strProgress||""; if(!isFinalWord(raw)) return false; const t=eventMillis(m); if(Number.isNaN(t)) return false; return (Date.now()-t)>FINAL_KEEP_MS; }
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
  if (pa===0) return tb-ta; return ta-tb;
}

// ------------ league matching ------------
function leagueMatch(m, leagueId, sport){
  const idOk = String(m.idLeague||"")===String(leagueId);
  const name = String(m.strLeague||"").toLowerCase();
  if (sport==="american_football") return idOk || name.includes("nfl");
  if (sport==="basketball")        return idOk;
  if (sport==="ice_hockey")        return idOk || name.includes("nhl");
  return idOk; // soccer strict when a single id is used
}

// ------------ TSDB wrappers ------------
async function v2Livescore(sport){
  const s=sport.replace(/_/g," ");
  const urls=[
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out=[]; for (const u of urls){ const j=await memoJson(u, TTL.LIVE, {"X-API-KEY":V2_KEY}); if (j?.livescore?.length) out.push(...j.livescore); }
  return out;
}
async function v1NextLeague(id){ const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsnextleague.php?id=${id}`, TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`, TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventspastleague.php?id=${id}`, TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }
const SPORT_LABEL={ soccer:"Soccer", basketball:"Basketball", american_football:"American Football", ice_hockey:"Ice Hockey" };
async function v1EventsDay(sport, ymd){ const label=SPORT_LABEL[sport]||sport; const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`, TTL.DAY); return Array.isArray(j?.events)?j.events:[]; }

// ------------ seasons ------------
function guessSeasonCrossYear(){ const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1, s=(m>=7)?y:y-1; return `${s}-${s+1}`; }
function seasonCandidates(sport, leagueId){
  const d=new Date(), y=d.getUTCFullYear(), cross=guessSeasonCrossYear(), crossPrev=`${y-1}-${y}`, single=String(y), singlePrev=String(y-1);
  if (leagueId===4391||sport==="american_football") return [single, singlePrev, cross, crossPrev];
  if (leagueId===4387||leagueId===4380)             return [cross, crossPrev, single, singlePrev];
  if (leagueId===4328)                               return [cross, crossPrev];
  return [cross, single, crossPrev, singlePrev];
}

// ------------ build helpers ------------
async function fillByDaysUntilFilter(out, sport, leagueIds, n, maxWeeks){
  if (out.length>=n) return;
  const idSet = new Set(leagueIds.map(String));
  const keys=new Set(out.map(matchKey));
  const today=new Date();
  for (let w=0; w<maxWeeks && out.length<n; w++){
    for (let d=0; d<7 && out.length<n; d++){
      const dt=new Date(today.getTime()+(w*7+d)*86400000);
      const ymd=dt.toISOString().slice(0,10);
      const rows=await v1EventsDay(sport, ymd);
      for (const m of rows){
        if (out.length>=n) break;
        if (!idSet.has(String(m.idLeague||""))) continue;
        const ms=eventMillis(m); if (isFinite(ms)&&ms<Date.now()) continue;
        const k=matchKey(m); if (keys.has(k)) continue;
        keys.add(k); out.push(m);
      }
    }
    console.log(`[day fill week ${w}] ${sport} (multi) -> ${out.length}/${n}`);
  }
}
async function buildSoccerMulti(leagueIds, n){
  const out=[]; const idSet=new Set(leagueIds.map(String));
  console.log(`\n=== build soccer multi ${[...idSet].join(",")} n=${n} ===`);

  // LIVE once for the sport
  const live=await v2Livescore("soccer");
  for (const m of live||[]){ if (!idSet.has(String(m.idLeague||""))) continue; if (isOldFinal(m)) continue; pushUnique(out,m); }
  console.log(`[live] soccer -> ${out.length}`);

  // NEXT / SEASON / PAST per league (retry handled inside)
  for (const lid of leagueIds){
    if (out.length>=n) break;
    const nxt=await v1NextLeague(lid);
    nxt.sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of nxt){ if (out.length>=n) break; if (String(m.idLeague||"")!==String(lid)) continue; pushUnique(out,m); }
    console.log(`[next] league ${lid} -> ${out.length}/${n}`);
  }
  if (out.length<n){
    for (const lid of leagueIds){
      for (const s of seasonCandidates("soccer", 4328)){ // season strings work across leagues
        const e=await v1Season(lid, s);
        const now=Date.now();
        const fut=e.filter(x=>String(x.idLeague||"")===String(lid) && isFinite(eventMillis(x)) && eventMillis(x)>=now)
                   .sort((a,b)=>eventMillis(a)-eventMillis(b));
        for (const m of fut){ if (out.length>=n) break; pushUnique(out,m); }
        console.log(`[season ${s}] league ${lid} -> ${out.length}/${n}`);
        if (out.length>=n) break;
      }
      if (out.length>=n) break;
    }
  }

  // DAY scan over the sport, filter by ids
  await fillByDaysUntilFilter(out, "soccer", leagueIds, n, 8);

  if (out.length<n){
    for (const lid of leagueIds){
      const e=await v1PastLeague(lid);
      e.sort((a,b)=>eventMillis(b)-eventMillis(a));
      for (const m of e){ if (out.length>=n) break; if (String(m.idLeague||"")!==String(lid)) continue; m.strStatus=m.strStatus||"Final"; if (isOldFinal(m)) continue; pushUnique(out,m); }
      console.log(`[past] league ${lid} -> ${out.length}/${n}`);
      if (out.length>=n) break;
    }
  }

  out.sort(sortForDisplay);
  return out.slice(0,n);
}

// single-league builder retained for NBA/NFL/NHL
async function getLeagueMatchesCore(sport, leagueId, n){
  const out=[]; console.log(`\n=== build ${sport} (league ${leagueId}) n=${n} ===`);
  const live=await v2Livescore(sport);
  for (const m of live||[]){ if (!leagueMatch(m, leagueId, sport)) continue; if (isOldFinal(m)) continue; pushUnique(out,m); }
  console.log(`[live] ${sport} -> ${out.length}`);
  if (out.length<n){
    const e=await v1NextLeague(leagueId);
    e.sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of e){ if (out.length>=n) break; if (!leagueMatch(m, leagueId, sport)) continue; pushUnique(out,m); }
    console.log(`[next v1] ${sport} -> ${out.length}/${n}`);
  }
  if (out.length<n){
    for (const s of seasonCandidates(sport, leagueId)){
      const e=await v1Season(leagueId,s);
      const now=Date.now();
      const fut=e.filter(x=>leagueMatch(x,leagueId,sport) && isFinite(eventMillis(x)) && eventMillis(x)>=now)
                 .sort((a,b)=>eventMillis(a)-eventMillis(b));
      for (const m of fut){ if (out.length>=n) break; pushUnique(out,m); }
      console.log(`[season ${s}] ${sport} -> ${out.length}/${n}`);
      if (out.length>=n) break;
    }
  }
  const weeks = (sport==="american_football") ? 10 : 6;
  await (async function fillByDaysUntil(outArr, spt, lid, need, maxWeeks){
    if (outArr.length>=need) return;
    const keys=new Set(outArr.map(matchKey));
    const today=new Date();
    for (let w=0; w<maxWeeks && outArr.length<need; w++){
      for (let d=0; d<7 && outArr.length<need; d++){
        const dt=new Date(today.getTime()+(w*7+d)*86400000);
        const ymd=dt.toISOString().slice(0,10);
        const rows=await v1EventsDay(spt, ymd);
        for (const m of rows){
          if (outArr.length>=need) break;
          if (!leagueMatch(m, lid, spt)) continue;
          const ms=eventMillis(m); if (isFinite(ms)&&ms<Date.now()) continue;
          const k=matchKey(m); if (keys.has(k)) continue;
          keys.add(k); outArr.push(m);
        }
      }
      console.log(`[day fill week ${w}] ${spt} -> ${outArr.length}/${need}`);
    }
  })(out, sport, leagueId, n, weeks);

  if (out.length<n){
    const e=await v1PastLeague(leagueId);
    e.sort((a,b)=>eventMillis(b)-eventMillis(a));
    for (const m of e){ if (out.length>=n) break; if (!leagueMatch(m,leagueId,sport)) continue; m.strStatus=m.strStatus||"Final"; if (isOldFinal(m)) continue; pushUnique(out,m); }
    console.log(`[past recent] ${sport} -> ${out.length}/${n}`);
  }
  out.sort(sortForDisplay);
  return out.slice(0,n);
}

// cached wrappers
async function getSoccerMultiCached(ids, n){
  const key=`OUT:soccer:${ids.join(",")}:${n}`; const hit=getC(key); if (hit) return hit;
  const data=await buildSoccerMulti(ids, n); setC(key, data, TTL.OUT + Math.floor(Math.random()*5000)); return data;
}
async function getLeagueMatchesCached(sport, leagueId, n){
  const key=`OUT:${sport}:${leagueId}:${n}`; const hit=getC(key); if (hit) return hit;
  const data=await getLeagueMatchesCore(sport, leagueId, n); setC(key, data, TTL.OUT + Math.floor(Math.random()*5000)); return data;
}

// format
function formatMatch(m){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"";
  const away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=pickScore(m.intHomeScore??m.intHomeGoals);
  const s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const status=normalizeStatus(m,s1,s2);
  const ms=eventMillis(m);
  return { team1:home, team2:away, score1:s1===null?"N/A":String(s1), score2:s2===null?"N/A":String(s2),
           headline:`${home} vs ${away} - ${status}`, start:isFinite(ms)?new Date(ms).toISOString():null };
}

// endpoints
const SOCCER_IDS = [4328, 4331, 4335, 4334]; // EPL, Bundesliga, LaLiga, Ligue 1 (TSDB)
const CONFIGS = {
  "/scores/soccer": { multi:true, ids:SOCCER_IDS },
  "/scores/nba":    { sport:"basketball",        leagueId:4387 },
  "/scores/nfl":    { sport:"american_football", leagueId:4391 },
  "/scores/nhl":    { sport:"ice_hockey",        leagueId:4380 },
};

for (const [path,cfg] of Object.entries(CONFIGS)){
  app.get(path, async (req,res)=>{
    try{
      const n = Math.max(5, Math.min(20, parseInt(req.query.n || DEFAULT_COUNT, 10) || DEFAULT_COUNT));
      let items;
      if (cfg.multi){ items = await getSoccerMultiCached(cfg.ids, n); }
      else { items = await getLeagueMatchesCached(cfg.sport, cfg.leagueId, n); }
      console.log(`${path} → ${items.length} items (n=${n})`);
      res.json(items.map(formatMatch));
    }catch(e){ console.error(path,"handler error:",e); res.status(500).json({error:"internal"}); }
  });
}

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
