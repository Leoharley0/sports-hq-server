// server.js — TSDB-only with caching + robust day-fill + explicit sort order
// Order: recent Finals (≤15m) → LIVE → Scheduled (soonest first)
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// Polyfill fetch for older Node
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// Env (Render → Environment)
const V2_KEY = process.env.TSDB_V2_KEY || "";
const V1_KEY = process.env.TSDB_V1_KEY || "";
if (!V2_KEY) console.error("❌ Missing TSDB_V2_KEY (required for LIVE)");
if (!V1_KEY) console.warn("⚠️  TSDB_V1_KEY not set; v1 calls will fail");

// Friendly headers
const COMMON_HEADERS = { "User-Agent": "SportsHQ/1.0 (+render.com)", "Accept": "application/json" };

// Finals visibility window
const FINAL_KEEP_MINUTES = 15;
const FINAL_KEEP_MS = FINAL_KEEP_MINUTES * 60 * 1000;

/* ---------------- simple in-memory cache ---------------- */
const cache = new Map();
function getCache(k){ const v = cache.get(k); if (v && v.exp > Date.now()) return v.val; if (v) cache.delete(k); return null; }
function setCache(k,val,ttl){ cache.set(k,{val,exp:Date.now()+ttl}); }

/* ---------------- fetch helpers (with memo) ---------------- */
async function fetchText(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...COMMON_HEADERS, ...extraHeaders } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} | ${text.slice(0,180)}`);
  return text;
}
async function fetchJson(url, extraHeaders = {}) {
  const txt = await fetchText(url, extraHeaders);
  return JSON.parse(txt);
}
async function memoJson(url, ttlMs, extraHeaders = {}) {
  const k = `URL:${url}`;
  const hit = getCache(k); if (hit) return hit;
  try {
    const j = await fetchJson(url, extraHeaders);
    if (j) setCache(k, j, ttlMs);
    return j;
  } catch (e) {
    console.error("fetchJson error:", e.message, "→", url);
    return null;
  }
}

/* ---------------- time / status / format helpers ---------------- */
function toMillis(dateEvent, strTime){
  if (!dateEvent) return NaN;
  const t = (strTime || "00:00:00").trim();
  const hasTZ = /[zZ]$|[+\-]\d\d:?\d\d$/.test(t);
  const ms = Date.parse(`${dateEvent}T${t}${hasTZ ? "" : "Z"}`);
  return Number.isNaN(ms) ? NaN : ms;
}
function eventMillis(m){
  if (m.dateEvent){ const ms = toMillis(m.dateEvent, m.strTime); if (!Number.isNaN(ms)) return ms; }
  if (m.strTimestampMS){ const n = +m.strTimestampMS; if (!Number.isNaN(n)) return n; }
  if (m.strTimestamp){ const n = +m.strTimestamp * 1000; if (!Number.isNaN(n)) return n; }
  return NaN;
}
function isLiveWord(s=""){ const t=(s+"").toLowerCase(); return t.includes("live")||t.includes("in play")||/^q\d/.test(t)||t.includes("quarter")||t.includes("ot")||t.includes("overtime")||t.includes("half")||t==="ht"; }
function isFinalWord(s=""){ const t=(s+"").toLowerCase(); return t.includes("final")||t==="ft"||t.includes("full time"); }
function pickScore(v){ return (v===undefined||v===null||v===""||v==="N/A")?null:v; }
function normalizeStatus(m,s1,s2){
  const raw=String(m.strStatus||m.strProgress||"").trim();
  const hasScore=(s1!==null)||(s2!==null);
  if (isFinalWord(raw)) return "Final";
  if (isLiveWord(raw))  return hasScore ? "LIVE" : "Scheduled";
  if (!raw||raw==="NS"||raw.toLowerCase()==="scheduled"||raw.toLowerCase()==="preview") return "Scheduled";
  return hasScore ? raw : "Scheduled";
}
function formatMatch(m){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"";
  const away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=pickScore(m.intHomeScore??m.intHomeScoreTotal??m.intHomeScore1??m.intHomeGoals);
  const s2=pickScore(m.intAwayScore??m.intAwayScoreTotal??m.intAwayScore1??m.intAwayGoals);
  const status=normalizeStatus(m,s1,s2);
  return { team1:home, team2:away, score1:s1===null?"N/A":String(s1), score2:s2===null?"N/A":String(s2), headline:`${home} vs ${away} - ${status}` };
}
function matchKey(m){ return m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent}`; }
function pushUnique(arr,m){ const k=matchKey(m); if (!arr.some(x=>matchKey(x)===k)) arr.push(m); }
function isOldFinal(m){
  const raw=m.strStatus||m.strProgress||""; if (!isFinalWord(raw)) return false;
  const t=eventMillis(m); if (Number.isNaN(t)) return false;
  return (Date.now()-t) > FINAL_KEEP_MS;
}

// compute status for sorting
function computedStatus(m){
  const s1=pickScore(m.intHomeScore??m.intHomeScoreTotal??m.intHomeScore1??m.intHomeGoals);
  const s2=pickScore(m.intAwayScore??m.intAwayScoreTotal??m.intAwayScore1??m.intAwayGoals);
  return normalizeStatus(m, s1, s2);
}
// final comparator: Finals (newest first) → LIVE (by start) → Scheduled (soonest first)
function sortForDisplay(a,b){
  const sa = computedStatus(a), sb = computedStatus(b);
  const pa = (sa==="Final")?0 : (sa==="LIVE")?1 : 2;
  const pb = (sb==="Final")?0 : (sb==="LIVE")?1 : 2;
  if (pa !== pb) return pa - pb;

  const ta = eventMillis(a), tb = eventMillis(b);
  if (pa === 0) { // Finals — newest first
    if (isFinite(ta) && isFinite(tb)) return tb - ta;
  } else if (pa === 1) { // Live — older start first (optional; keeps stable)
    if (isFinite(ta) && isFinite(tb)) return ta - tb;
  } else { // Scheduled — soonest first
    if (isFinite(ta) && isFinite(tb)) return ta - tb;
  }
  return 0;
}

/* ---------------- diagnostics ---------------- */
function guessSeasonCrossYear(){ const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1, s=(m>=7)?y:y-1; return `${s}-${s+1}`; }
async function probe(url, extra={}){ try{ const t=await fetchText(url, extra); return {ok:true,status:200,url,preview:t.slice(0,160)}; }catch(e){ return {ok:false,status:0,url,error:String(e)}; } }
app.get("/diag", async (_,res)=>{
  const season=guessSeasonCrossYear(), v2h={"X-API-KEY":V2_KEY};
  const checks=[];
  checks.push({env:{node:process.version,hasV2Key:!!V2_KEY,v2KeyLen:(V2_KEY||"").length,hasV1Key:!!V1_KEY,v1Key:V1_KEY,cacheEntries:cache.size}});
  checks.push(await probe(`https://www.thesportsdb.com/api/v2/json/livescore/soccer`, v2h));
  for (const [_,id] of [["NBA",4387],["NHL",4380],["EPL",4328],["NFL",4391]]){
    checks.push(await probe(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsnextleague.php?id=${id}`));
    checks.push(await probe(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsseason.php?id=${id}&s=${encodeURIComponent(season)}`));
  }
  res.json({ok:true,season,checks});
});

/* ---------------- TSDB fetchers (memoized) ---------------- */
const TTL = { LIVE:15*1000, NEXT:5*60*1000, SEASON:3*60*60*1000, DAY:30*60*1000, PAST:10*60*1000, OUT:25*1000 };

async function v2Livescore(sport){
  const s=sport.replace(/_/g," ");
  const urls=[
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out=[];
  for (const u of urls){ const j=await memoJson(u, TTL.LIVE, {"X-API-KEY":V2_KEY}); if (j?.livescore?.length) out.push(...j.livescore); }
  return out;
}
async function v1NextLeague(id){ const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsnextleague.php?id=${id}`, TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id, s){ const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`, TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventspastleague.php?id=${id}`, TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }

const SPORT_LABEL = { soccer:"Soccer", basketball:"Basketball", american_football:"American Football", ice_hockey:"Ice Hockey" };
async function v1EventsDay(sport, ymd){
  const label=SPORT_LABEL[sport]||sport;
  const j=await memoJson(`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`, TTL.DAY);
  return Array.isArray(j?.events)?j.events:[];
}

async function fillByDaysUntilFive(out, sport, leagueId, maxWeeks = 6){
  if (out.length >= 5) return;
  const keys = new Set(out.map(matchKey));
  const today = new Date();

  for (let w = 0; w < maxWeeks && out.length < 5; w++){
    const start = w*7, end = start+7;
    for (let d = start; d < end && out.length < 5; d++){
      const dt = new Date(today.getTime() + d*86400000);
      const ymd = dt.toISOString().slice(0,10);
      const rows = await v1EventsDay(sport, ymd);
      for (const m of rows){
        if (out.length >= 5) break;
        if (String(m.idLeague||"") !== String(leagueId)) continue;
        const ms = toMillis(m.dateEvent, m.strTime);
        if (isFinite(ms) && ms < Date.now()) continue;
        const k = matchKey(m);
        if (keys.has(k)) continue;
        keys.add(k);
        out.push(m);
      }
    }
    console.log(`[day v1 fill week ${w}] ${sport} -> ${out.length}`);
  }
}

/* ---------------- season format candidates ---------------- */
function seasonCandidates(sport, leagueId){
  const d=new Date(); const y=d.getUTCFullYear();
  const cross=guessSeasonCrossYear(), crossPrev=`${y-1}-${y}`, single=String(y), singlePrev=String(y-1);
  if (leagueId===4391||sport==="american_football") return [single, singlePrev, cross, crossPrev];
  if (leagueId===4387||leagueId===4380)             return [cross, crossPrev, single, singlePrev];
  if (leagueId===4328)                               return [cross, crossPrev];
  return [cross, single, crossPrev, singlePrev];
}

/* ---------------- builder ---------------- */
async function getLeagueMatchesCore(sport, leagueId){
  const out=[];

  // 1) LIVE
  const live=await v2Livescore(sport);
  for (const m of live||[]){ if (String(m.idLeague||"")!==String(leagueId)) continue; if (isOldFinal(m)) continue; pushUnique(out,m); }
  console.log(`[live] ${sport} league=${leagueId} -> ${out.length}`);

  // 2) NEXT
  if (out.length<5){
    const e=await v1NextLeague(leagueId);
    e.sort((a,b)=>toMillis(a.dateEvent,a.strTime)-toMillis(b.dateEvent,b.strTime));
    for (const m of e){ if (out.length>=5) break; pushUnique(out,m); }
    console.log(`[next v1] ${sport} -> ${out.length}`);
  }

  // 3) SEASON (future only; multiple formats)
  if (out.length<5){
    const tried=[];
    for (const s of seasonCandidates(sport, leagueId)){
      tried.push(s);
      const e=await v1Season(leagueId,s);
      const now=Date.now();
      const fut=e.filter(x=>{ const t=toMillis(x.dateEvent,x.strTime); return isFinite(t)&&t>=now; })
                 .sort((a,b)=>toMillis(a.dateEvent,a.strTime)-toMillis(b.dateEvent,b.strTime));
      for (const m of fut){ if (out.length>=5) break; pushUnique(out,m); }
      console.log(`[season v1 tried=${tried.join(",")}] ${sport} -> ${out.length}`);
      if (out.length>=5) break;
    }
  }

  // 4) DAY scan until 5 unique (TSDB-only)
  await fillByDaysUntilFive(out, sport, leagueId, 6);

  // 5) PAST (very recent finals ≤ 15m)
  if (out.length<5){
    const e=await v1PastLeague(leagueId);
    e.sort((a,b)=>toMillis(b.dateEvent,b.strTime)-toMillis(a.dateEvent,a.strTime));
    for (const m of e){ if (out.length>=5) break; m.strStatus=m.strStatus||"Final"; if (isOldFinal(m)) continue; pushUnique(out,m); }
    console.log(`[past v1 recent≤${FINAL_KEEP_MINUTES}m] ${sport} -> ${out.length}`);
  }

  // >>> NEW: final sort for display <<<
  out.sort(sortForDisplay);

  return out.slice(0,5);
}

// small cache for final per-league response
const TTL_OUT = 25*1000;
async function getLeagueMatchesCached(sport, leagueId){
  const key=`OUT:${sport}:${leagueId}`;
  const hit=getCache(key); if (hit) return hit;
  const data=await getLeagueMatchesCore(sport, leagueId);
  setCache(key, data, TTL_OUT + Math.floor(Math.random()*5000));
  return data;
}

/* ---------------- endpoints ---------------- */
const CONFIGS = {
  "/scores/soccer": { sport:"soccer",            leagueId:4328 },
  "/scores/nba":    { sport:"basketball",        leagueId:4387 },
  "/scores/nfl":    { sport:"american_football", leagueId:4391 },
  "/scores/nhl":    { sport:"ice_hockey",        leagueId:4380 },
};
for (const [path,cfg] of Object.entries(CONFIGS)){
  app.get(path, async (req,res)=>{
    try{
      const items=await getLeagueMatchesCached(cfg.sport,cfg.leagueId);
      console.log(`${path} → ${items.length} items`);
      res.json(items.map(formatMatch));
    }catch(e){
      console.error(path,"handler error:",e);
      res.status(500).json({error:"internal"});
    }
  });
}

app.get("/",(_,res)=>res.send("Sports HQ server ok"));
app.get("/health",(_,res)=>res.json({ok:true}));

app.listen(PORT, ()=>console.log(`Server listening on ${PORT}`));