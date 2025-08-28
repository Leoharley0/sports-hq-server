// server.js — SportsHQ v14
// - Soccer limited to EPL/Bundesliga/LaLiga/Ligue 1
// - Time-aware status (avoids false LIVE)
// - Robust against 429s (cooldown + last-good)
// - Sorting: Finals newest → Live closest-to-now → Scheduled soonest

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v14 (soccer 4-league + robust + closest/soonest sort)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ===== ENV =====
const V2_KEY = process.env.TSDB_V2_KEY || "";       // optional (v2 livescore)
const V1_KEY = process.env.TSDB_V1_KEY || "3";      // default free key
if (!V1_KEY) console.warn("⚠️ TSDB_V1_KEY missing; using '3'.");
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY not set; live rows may be fewer.");

// ===== Tunables =====
const DEFAULT_COUNT = 10;
const TTL = { LIVE:15e3, NEXT:5*60e3, SEASON:3*60*60e3, DAY:30*60e3, PAST:10*60e3, OUT:45e3 };
const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };

// ===== Caches & 429 cooldown =====
const cache=new Map(), lastGood=new Map(), inflight=new Map();
const getC=k=>{const v=cache.get(k); if(v&&v.exp>Date.now()) return v.val; if(v) cache.delete(k); return null;};
const setC=(k,val,ttl)=>{cache.set(k,{val,exp:Date.now()+ttl}); lastGood.set(k,val);};
let V1_COOL_UNTIL=0; const isV1=u=>u.includes("/api/v1/json/"); const cooling=()=>Date.now()<V1_COOL_UNTIL;
function startCooldown(retry){ const s=Math.max(30, Math.min(120, Number(retry)||60)); V1_COOL_UNTIL=Date.now()+s*1000+Math.random()*5e3; console.warn(`[rate-gate] v1 cooldown ${s}s`); }

async function memoJson(url, ttl, extraHdrs={}){
  const key=`URL:${url}`;
  const fresh=getC(key); if(fresh) return fresh;
  if(isV1(url) && cooling()){ const lg=lastGood.get(key); if(lg) return lg; return null; }
  if(inflight.has(key)) return inflight.get(key);

  const p=(async()=>{
    try{
      const res=await fetch(url,{headers:{...COMMON_HEADERS,...extraHdrs}});
      const txt=await res.text();
      if(res.status===429){ startCooldown(res.headers.get("Retry-After")); const lg=lastGood.get(key); if(lg){console.warn("↺ last-good",url); return lg;} return null; }
      if(!res.ok) throw new Error(`${res.status} ${res.statusText} | ${txt.slice(0,180)}`);
      const j=JSON.parse(txt); if(j) setC(key,j,ttl); return j;
    }catch(e){ console.error("fetch error:", e.message, "→", url); const lg=lastGood.get(key); if(lg){console.warn("↺ last-good",url); return lg;} return null; }
    finally{ inflight.delete(key); }
  })();
  inflight.set(key,p); return p;
}

// ===== Time / status helpers =====
function cleanTime(t){ if(!t) return "00:00:00"; const s=String(t).trim(); return (/^tba$|^tbd$/i.test(s))?"00:00:00":s; }
function toMillis(dateStr,timeStr){ if(!dateStr) return NaN; const t=cleanTime(timeStr); const hasTZ=/[zZ]$|[+\-]\d\d:?\d\d$/.test(t); const ms=Date.parse(`${dateStr}T${t}${hasTZ?"":"Z"}`); return Number.isNaN(ms)?NaN:ms; }
function eventMillis(m){
  let ms=toMillis(m.dateEvent,m.strTime); if(!Number.isNaN(ms)) return ms;
  ms=toMillis(m.dateEventLocal||m.dateEvent,m.strTimeLocal||m.strTime); if(!Number.isNaN(ms)) return ms;
  if(m.strTimestampMS){const n=+m.strTimestampMS; if(!Number.isNaN(n)) return n;}
  if(m.strTimestamp){const n=+m.strTimestamp*1000; if(!Number.isNaN(n)) return n;}
  if(m.dateEvent){ms=toMillis(m.dateEvent,"00:00:00Z"); if(!Number.isNaN(ms)) return ms;}
  if(m.dateEventLocal){ms=toMillis(m.dateEventLocal,"00:00:00Z"); if(!Number.isNaN(ms)) return ms;}
  return NaN;
}
function pickScore(v){ return (v===undefined||v===null||v===""||v==="N/A")?null:v; }
const isLiveWord=s=>{const t=String(s||"").toLowerCase(); return t==="live"||t.includes("in play")||t==="ht"||t==="1h"||t==="2h";};
const isFinalWord=s=>{const t=String(s||"").toLowerCase(); return t.includes("final")||t==="ft"||t.includes("full time");};

function normalizeStatus(m,s1,s2){
  const raw=String(m.strStatus||m.strProgress||"").trim();
  const ms=eventMillis(m), now=Date.now();
  if(isFinalWord(raw)) return "Final";
  if(isLiveWord(raw)){
    if(isFinite(ms) && ms > now + 15*60*1000) return "Scheduled";
    if(s1===null && s2===null && isFinite(ms) && now < ms + 10*60*1000) return "Scheduled";
    return "LIVE";
  }
  const low=raw.toLowerCase();
  if(!raw || low==="ns" || low==="not started" || low==="scheduled" || low==="preview") return "Scheduled";
  return (s1!==null || s2!==null) ? raw : "Scheduled";
}
const FINAL_KEEP_MS=15*60*1000;
function isOldFinal(m){ const raw=m.strStatus||m.strProgress||""; if(!isFinalWord(raw)) return false; const t=eventMillis(m); if(Number.isNaN(t)) return false; return (Date.now()-t)>FINAL_KEEP_MS; }
function computedStatus(m){ const s1=pickScore(m.intHomeScore??m.intHomeGoals), s2=pickScore(m.intAwayScore??m.intAwayGoals); return normalizeStatus(m,s1,s2); }

// ===== SORT: Finals newest → Live closest-to-now → Scheduled soonest =====
function sortForDisplay(a,b){
  const sa=computedStatus(a), sb=computedStatus(b);
  const bucket = s => (s==="Final")?0 : (s==="LIVE")?1 : 2;
  const pa=bucket(sa), pb=bucket(sb);
  if(pa!==pb) return pa-pb;

  const ta=eventMillis(a), tb=eventMillis(b);
  const aBad=!isFinite(ta), bBad=!isFinite(tb);
  if(aBad && !bBad) return +1;
  if(!aBad && bBad) return -1;

  if (pa===0) {                 // Finals: newest first
    return tb - ta;
  } else if (pa===1) {          // Live: closest to now first
    const now=Date.now();
    const da=Math.abs(ta-now), db=Math.abs(tb-now);
    if (da!==db) return da-db;
    return ta - tb;            // tie-breaker
  } else {                      // Scheduled: soonest kickoff first
    return ta - tb;
  }
}

// ===== League matching =====
function leagueMatch(m, leagueId, sport){
  const idOk=String(m.idLeague||"")===String(leagueId);
  const name=String(m.strLeague||"").toLowerCase();
  if (sport==="american_football") return idOk || name.includes("nfl");
  if (sport==="basketball")        return idOk;
  if (sport==="ice_hockey")        return idOk || name.includes("nhl");
  return idOk;
}

// ===== TSDB fetchers =====
async function v2Livescore(sport){
  if(!V2_KEY) return [];
  const s=sport.replace(/_/g," ");
  const urls=[
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out=[]; for(const u of urls){ const j=await memoJson(u, TTL.LIVE, {"X-API-KEY":V2_KEY}); if(j?.livescore?.length) out.push(...j.livescore); }
  return out;
}
async function v1NextLeague(id){ const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsnextleague.php?id=${id}`, TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`, TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventspastleague.php?id=${id}`, TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }
const SPORT_LABEL={ soccer:"Soccer", basketball:"Basketball", american_football:"American Football", ice_hockey:"Ice Hockey" };
async function v1EventsDay(sport, ymd){ const label=SPORT_LABEL[sport]||sport; const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`, TTL.DAY); return Array.isArray(j?.events)?j.events:[]; }

// ===== Seasons =====
function guessSeasonCrossYear(){ const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1, s=(m>=7)?y:y-1; return `${s}-${s+1}`; }
function seasonCandidates(sport, leagueId){
  const d=new Date(), y=d.getUTCFullYear(), cross=guessSeasonCrossYear(), crossPrev=`${y-1}-${y}`, single=String(y), singlePrev=String(y-1);
  if (leagueId===4391||sport==="american_football") return [single, singlePrev, cross, crossPrev];
  if (leagueId===4387||leagueId===4380)             return [cross, crossPrev, single, singlePrev];
  if (leagueId===4328)                               return [cross, crossPrev];
  return [cross, single, crossPrev, singlePrev];
}

// ===== Fill future by day (light) =====
async function fillByDaysUntil(out, sport, leagueId, n, maxWeeks=1){
  if(out.length>=n) return;
  const keys=new Set(out.map(matchKey));
  const today=new Date();
  for(let w=0; w<maxWeeks && out.length<n; w++){
    for(let d=0; d<7 && out.length<n; d++){
      const dt=new Date(today.getTime()+(w*7+d)*86400000);
      const ymd=dt.toISOString().slice(0,10);
      const rows=await v1EventsDay(sport, ymd) || [];
      for(const m of rows){
        if(out.length>=n) break;
        if(!leagueMatch(m,leagueId,sport)) continue;
        const ms=eventMillis(m); if(isFinite(ms)&&ms<Date.now()) continue;
        const k=matchKey(m); if(keys.has(k)) continue;
        keys.add(k); out.push(m);
      }
    }
    console.log(`[day v1 fill week ${w}] ${sport}/${leagueId} -> ${out.length}/${n}`);
  }
}

// ===== Build list for a league =====
function matchKey(m){ return m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`; }
function pushUnique(arr,m){ const k=matchKey(m); if(!arr.some(x=>matchKey(x)===k)) arr.push(m); }
function isOldFinal(m){ const raw=m.strStatus||m.strProgress||""; if(!isFinalWord(raw)) return false; const t=eventMillis(m); if(Number.isNaN(t)) return false; return (Date.now()-t)>15*60*1000; }

async function getLeagueMatchesCore(sport, leagueId, n){
  const out=[];
  const live=await v2Livescore(sport);
  for(const m of live||[]){ if(!leagueMatch(m,leagueId,sport)) continue; if(isOldFinal(m)) continue; pushUnique(out,m); }
  console.log(`[live] ${sport}/${leagueId} -> ${out.length}`);

  if(out.length<n){
    const e=await v1NextLeague(leagueId) || [];
    e.sort((a,b)=>eventMillis(a)-eventMillis(b));
    for(const m of e){ if(out.length>=n) break; if(!leagueMatch(m,leagueId,sport)) continue; pushUnique(out,m); }
    console.log(`[next v1] ${sport}/${leagueId} -> ${out.length}/${n}`);
  }

  if(out.length<n){
    for(const s of seasonCandidates(sport,leagueId)){
      const e=await v1Season(leagueId,s) || [];
      const now=Date.now();
      const fut=e.filter(x=>leagueMatch(x,leagueId,sport) && isFinite(eventMillis(x)) && eventMillis(x)>=now)
                 .sort((a,b)=>eventMillis(a)-eventMillis(b));
      for(const m of fut){ if(out.length>=n) break; pushUnique(out,m); }
      console.log(`[season ${s}] ${sport}/${leagueId} -> ${out.length}/${n}`);
      if(out.length>=n) break;
    }
  }

  await fillByDaysUntil(out, sport, leagueId, n, 1);

  if(out.length<n){
    const e=await v1PastLeague(leagueId) || [];
    e.sort((a,b)=>eventMillis(b)-eventMillis(a));
    for(const m of e){ if(out.length>=n) break; if(!leagueMatch(m,leagueId,sport)) continue; m.strStatus=m.strStatus||"Final"; if(isOldFinal(m)) continue; pushUnique(out,m); }
    console.log(`[past recent] ${sport}/${leagueId} -> ${out.length}/${n}`);
  }

  out.sort(sortForDisplay);
  return out.slice(0,n);
}

async function getLeagueMatchesCached(sport, leagueId, n){
  const key=`OUT:${sport}:${leagueId}:${n}`;
  const hit=getC(key); if(hit) return hit;
  const data=await getLeagueMatchesCore(sport, leagueId, n);
  setC(key, data, TTL.OUT + Math.random()*5000);
  return data;
}

// ===== Soccer: only these 4 leagues =====
const SOCCER_IDS = [4328, 4331, 4335, 4334]; // EPL, Bundesliga, LaLiga, Ligue 1
async function getSoccer(n){
  const merged=[]; const per=[];
  for(const id of SOCCER_IDS){
    const items=await getLeagueMatchesCached("soccer", id, n);
    per.push(`${id}:${items.length}`);
    for(const m of items) pushUnique(merged,m);
  }
  console.log(`[soccer agg] {${per.join(", ")}} merged=${merged.length}`);
  merged.sort(sortForDisplay);
  return merged.slice(0,n);
}

// ===== Output shape for Roblox =====
function formatMatch(m){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"";
  const away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=pickScore(m.intHomeScore??m.intHomeGoals);
  const s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const status=computedStatus(m);
  const ms=eventMillis(m);
  return {
    league: m.strLeague || "",
    team1: home, team2: away,
    score1: s1===null?"N/A":String(s1),
    score2: s2===null?"N/A":String(s2),
    status, isLive: status==="LIVE",
    headline: `${home} vs ${away} - ${status}`,
    start: isFinite(ms)?new Date(ms).toISOString():null
  };
}

// ===== Endpoints =====
const CONFIGS = {
  "/scores/nba":    { sport:"basketball",        leagueId:4387 },
  "/scores/nfl":    { sport:"american_football", leagueId:4391 },
  "/scores/nhl":    { sport:"ice_hockey",        leagueId:4380 },
};

app.get("/scores/soccer", async (req,res)=>{
  try{
    const n = Math.max(5, Math.min(20, parseInt(req.query.n || DEFAULT_COUNT, 10) || DEFAULT_COUNT));
    const items = await getSoccer(n);
    console.log(`/scores/soccer → ${items.length} items (n=${n})`);
    res.json(items.map(formatMatch));
  }catch(e){ console.error("/scores/soccer error:", e); res.status(500).json({error:"internal"}); }
});

for (const [path,cfg] of Object.entries(CONFIGS)){
  app.get(path, async (req,res)=>{
    try{
      const n = Math.max(5, Math.min(20, parseInt(req.query.n || DEFAULT_COUNT, 10) || DEFAULT_COUNT));
      const items = await getLeagueMatchesCached(cfg.sport, cfg.leagueId, n);
      console.log(`${path} → ${items.length} items (n=${n})`);
      res.json(items.map(formatMatch));
    }catch(e){ console.error(path,"error:",e); res.status(500).json({error:"internal"}); }
  });
}

app.get("/health",(_,res)=>res.json({ok:true}));

app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));