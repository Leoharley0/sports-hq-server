// server.js — v23: EPL-only board fixed (ID-or-string match + date-only fixtures), other boards unchanged.
// Order per board: Finals (<=15m) -> Live -> Scheduled(soonest). 10 rows, low-load cached.

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v23 (EPL fix: id-or-string match + date-only OK; NFL/NHL/NBA unchanged)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

// Polyfill fetch (Node < 18)
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ---------- ENV ----------
const V2_KEY = process.env.TSDB_V2_KEY || "";
const V1_KEY = process.env.TSDB_V1_KEY || "3";

// ---------- CONSTANTS ----------
const DEFAULT_COUNT = 10;

const TTL = {
  LIVE:   15_000,
  NEXT:   5 * 60_000,
  SEASON: 3 * 60 * 60_000,
  DAY:    30 * 60_000,
  OUT:    60_000
};
const SWR_EXTRA = 5 * 60_000;

const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const jitter = ms => ms + Math.floor(Math.random() * (ms/3));

// ---------- Cache + inflight ----------
const cache = new Map();    // key -> {val,exp,swr}
const inflight = new Map(); // key -> Promise

function getCache(key){
  const e = cache.get(key);
  if (!e) return { hit:false };
  const now = Date.now();
  if (now <= e.exp) return { hit:true, fresh:true,  val:e.val };
  if (now <= e.swr) return { hit:true, fresh:false, val:e.val };
  return { hit:false };
}
function setCache(key,val,ttl){
  const now = Date.now();
  cache.set(key, { val, exp: now + ttl, swr: now + ttl + SWR_EXTRA });
}
async function withInflight(key, fn){
  if (inflight.has(key)) return inflight.get(key);
  const p = (async()=>{ try{ return await fn(); } finally{ inflight.delete(key); } })();
  inflight.set(key, p);
  return p;
}

// ---------- Robust fetch ----------
async function fetchJsonRetry(url, extra={}, tries=4, baseDelay=650){
  let lastErr;
  for (let i=0;i<tries;i++){
    try{
      const res = await fetch(url, { headers: { ...COMMON_HEADERS, ...extra } });
      const txt = await res.text();
      if (res.status === 429){
        const ra = Number(res.headers?.get("retry-after")) || 0;
        const wait = jitter(ra ? ra*1000 : baseDelay*Math.pow(2,i));
        console.warn(`[429] wait ${wait}ms :: ${url}`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} | ${txt.slice(0,160)}`);
      return JSON.parse(txt);
    }catch(e){
      lastErr = e;
      const wait = jitter(baseDelay*Math.pow(2,i));
      console.warn(`[retry] ${e.message}; wait ${wait}ms :: ${url}`);
      await sleep(wait);
    }
  }
  console.error(`[FAIL] ${lastErr?.message} :: ${url}`);
  return null;
}
async function memoJson(url, ttl, extra={}){
  const key = `URL:${url}`;
  const c = getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher = async ()=> {
    const j = await fetchJsonRetry(url, extra);
    if (j) setCache(key, j, ttl);
    return j || c.val || null;
  };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ---------- time / status helpers ----------
function cleanTime(t){ if(!t) return ""; const s=String(t).trim(); return (/^tba$|^tbd$/i.test(s))?"":s; }
function toMillisDateOnly(d){ // noon UTC if time truly unknown
  const ms = Date.parse(`${d}T12:00:00Z`);
  return Number.isNaN(ms) ? NaN : ms;
}
function toMillis(d,t){
  if (!d) return NaN;
  const tt = cleanTime(t);
  if (!tt) return toMillisDateOnly(d);
  const hasTZ = /[zZ]$|[+\-]\d\d:?\d\d$/.test(tt);
  const ms = Date.parse(`${d}T${tt}${hasTZ?"":"Z"}`);
  return Number.isNaN(ms) ? toMillisDateOnly(d) : ms;
}
function eventMillis(m){
  // Prefer explicit date/time; gracefully accept date-only (no time).
  let ms = toMillis(m.dateEvent, m.strTime); if (!Number.isNaN(ms)) return ms;
  ms = toMillis(m.dateEventLocal||m.dateEvent, m.strTimeLocal||m.strTime); if (!Number.isNaN(ms)) return ms;
  if (m.strTimestampMS){ const n=+m.strTimestampMS; if (!Number.isNaN(n)) return n; }
  if (m.strTimestamp){ const n=+m.strTimestamp*1000; if (!Number.isNaN(n)) return n; }
  if (m.dateEvent)      { ms = toMillisDateOnly(m.dateEvent);      if (!Number.isNaN(ms)) return ms; }
  if (m.dateEventLocal) { ms = toMillisDateOnly(m.dateEventLocal); if (!Number.isNaN(ms)) return ms; }
  return NaN;
}
function pickScore(v){ return (v===undefined||v===null||v===""||v==="N/A") ? null : v; }
function isLiveWord(s=""){ s=(s+"").toLowerCase(); return s.includes("live")||s.includes("in play")||s.includes("half")||s==="ht"||s.includes("ot")||/^q\d/.test(s); }
function isFinalWord(s=""){ s=(s+"").toLowerCase(); return s.includes("final")||s==="ft"||s.includes("full time"); }
function normalizeStatus(m,s1,s2){
  const raw = String(m.strStatus||m.strProgress||"").trim(), hasScore = (s1!==null)||(s2!==null);
  if (isFinalWord(raw)) return "Final";
  if (isLiveWord(raw))  return hasScore ? "LIVE" : "Scheduled";
  if (!raw || raw==="NS" || /^preview$/i.test(raw) || /^scheduled$/i.test(raw)) return "Scheduled";
  return hasScore ? raw : "Scheduled";
}
const FINAL_KEEP_MS = 15*60*1000;
function isRecentFinal(m){
  const raw=m.strStatus||m.strProgress||"";
  if (!isFinalWord(raw)) return false;
  const ms=eventMillis(m); if (!isFinite(ms)) return false;
  return (Date.now()-ms) <= FINAL_KEEP_MS;
}
function computedStatus(m){
  const s1=pickScore(m.intHomeScore??m.intHomeGoals), s2=pickScore(m.intAwayScore??m.intAwayGoals);
  return normalizeStatus(m,s1,s2);
}
function matchKey(m){ return m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`; }
function pushUnique(arr,m){ const k=matchKey(m); if(!arr.some(x=>matchKey(x)===k)) arr.push(m); }
function sortForDisplay(a,b){
  const rank = s => s==="Final"?0 : s==="LIVE"?1 : 2;
  const sa=computedStatus(a), sb=computedStatus(b);
  if (rank(sa)!==rank(sb)) return rank(sa)-rank(sb);
  const ta=eventMillis(a), tb=eventMillis(b);
  const aBad=!isFinite(ta), bBad=!isFinite(tb);
  if (aBad && !bBad) return +1;
  if (!aBad && bBad) return -1;
  if (sa==="Final") return tb-ta; // newest finals first
  return ta-tb;                   // soonest first
}

// ---------- TSDB wrappers ----------
const V1 = (p)=>`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/${p}`;
async function v1NextLeague(id){ const j=await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(V1(`eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`), TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }
const SPORT_LABEL={ soccer:"Soccer", basketball:"Basketball", american_football:"American Football", ice_hockey:"Ice Hockey" };
async function v1EventsDay(sport, ymd){
  const label=SPORT_LABEL[sport]||sport;
  const j=await memoJson(V1(`eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`), TTL.DAY);
  return Array.isArray(j?.events)?j.events:[];
}
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

// ---------- seasons ----------
function guessSeasonCrossYear(){
  const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1;
  const start=(m>=7)?y:y-1; return `${start}-${start+1}`;
}
function seasonsCrossTriple(){ const c=guessSeasonCrossYear(); return [c, `${parseInt(c)-1}-${parseInt(c)}`, `${parseInt(c)+1}-${parseInt(c)+2}`]; }
function seasonsNFL(){ const y=(new Date()).getUTCFullYear(); const c=guessSeasonCrossYear(); return [String(y), String(y+1), c]; }

// ---------- league constants ----------
const L = { EPL:4328, NBA:4387, NFL:4391, NHL:4380 };

// EPL id-or-string matcher (some day feeds miss idLeague but have strLeague)
function isEPL(m){
  const idOk = String(m.idLeague||"") === String(L.EPL);
  const name = String(m.strLeague||"").toLowerCase();
  // be lenient but specific (avoid other “Premier League” variants)
  const nameOk = name.includes("english premier league") || name.includes("premier league (england)") || name.includes("english premier");
  return idOk || nameOk;
}

// ---------- formatting ----------
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

// ---------- core builders ----------
async function buildEPL(n){
  const finals=[], live=[], sched=[];
  const now = Date.now();

  // Finals (recent only)
  const past=await v1PastLeague(L.EPL);
  for (const m of (past||[])){ if (isRecentFinal(m)) pushUnique(finals, m); }
  finals.sort((a,b)=>eventMillis(b)-eventMillis(a));

  // Live (v2)
  const ls=await v2Livescore("soccer");
  for (const m of (ls||[])){ if (isEPL(m) && !isRecentFinal(m)) pushUnique(live, m); }

  // Next fixtures (cheap)
  const next=await v1NextLeague(L.EPL);
  for (const m of (next||[])){
    const ms=eventMillis(m);
    if (isFinite(ms) && ms>=now && isEPL(m)) pushUnique(sched, m);
  }
  if (finals.length+live.length+sched.length < n){
    // Season fixtures (future only)
    for (const s of seasonsCrossTriple()){
      const rows=await v1Season(L.EPL, s);
      const fut=(rows||[]).filter(isEPL).filter(m=>{const ms=eventMillis(m); return isFinite(ms) && ms>=now;});
      for (const m of fut){ if (finals.length+live.length+sched.length>=n) break; pushUnique(sched,m); }
      if (finals.length+live.length+sched.length>=n) break;
    }
  }
  if (finals.length+live.length+sched.length < n){
    // Day scan next 30 days — accept id OR string EPL matches; accept date-only
    const today=new Date();
    for (let d=0; d<30 && finals.length+live.length+sched.length<n; d++){
      const ymd=new Date(today.getTime()+d*86400000).toISOString().slice(0,10);
      const rows=await v1EventsDay("soccer", ymd);
      const fut=(rows||[]).filter(isEPL).filter(m=>{const ms=eventMillis(m); return isFinite(ms) && ms>=now;});
      for (const m of fut){ if (finals.length+live.length+sched.length>=n) break; pushUnique(sched,m); }
    }
  }

  const out=[...finals,...live,...sched].sort(sortForDisplay).slice(0,n);
  console.log(`[soccer:EPL] F=${finals.length} L=${live.length} S=${sched.length} -> out=${out.length}`);
  return out;
}

async function buildSingle({ sport, leagueId, seasons, n }){
  const finals=[], live=[], sched=[];
  const now = Date.now();

  const past=await v1PastLeague(leagueId);
  for (const m of (past||[])){ if (isRecentFinal(m)) pushUnique(finals, m); }
  finals.sort((a,b)=>eventMillis(b)-eventMillis(a));

  const ls=await v2Livescore(sport);
  for (const m of (ls||[])){ if (String(m.idLeague||"")===String(leagueId) && !isRecentFinal(m)) pushUnique(live, m); }

  for (const s of seasons){
    const rows=await v1Season(leagueId, s);
    const fut=(rows||[]).filter(m=>{const ms=eventMillis(m); return isFinite(ms) && ms>=now;});
    for (const m of fut){ if (finals.length+live.length+sched.length>=n) break; pushUnique(sched, m); }
    if (finals.length+live.length+sched.length>=n) break;
  }
  if (finals.length+live.length+sched.length < n){
    const nxt=(await v1NextLeague(leagueId)).sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of nxt){
      if (finals.length+live.length+sched.length>=n) break;
      const ms=eventMillis(m); if (!isFinite(ms)||ms<now) continue;
      pushUnique(sched, m);
    }
  }
  const out=[...finals,...live,...sched].sort(sortForDisplay).slice(0,n);
  console.log(`[${sport}:${leagueId}] F=${finals.length} L=${live.length} S=${sched.length} -> out=${out.length}`);
  return out;
}

// ---------- cached wrappers ----------
async function getBoardCached(key, builder){
  const c=getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const data=await builder(); setCache(key,data,TTL.OUT); return data; };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ---------- routes ----------
app.get("/scores/soccer", async (req,res)=>{
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n||DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const items = await getBoardCached(`OUT:EPL:${n}`, () => buildEPL(n));
    res.json(items.map(formatMatch));
  }catch(e){ console.error("soccer error:", e); res.status(500).json({error:"internal"}); }
});

app.get("/scores/nba", async (req,res)=>serveSingle(req,res,"basketball",        L.NBA, seasonsCrossTriple()));
app.get("/scores/nfl", async (req,res)=>serveSingle(req,res,"american_football", L.NFL, seasonsNFL()));
app.get("/scores/nhl", async (req,res)=>serveSingle(req,res,"ice_hockey",        L.NHL, seasonsCrossTriple()));

async function serveSingle(req,res,sport,leagueId,seasons){
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n||DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const items = await getBoardCached(`OUT:${sport}:${leagueId}:${n}`, () =>
      buildSingle({ sport, leagueId, seasons, n })
    );
    res.json(items.map(formatMatch));
  }catch(e){ console.error(`${sport} error:`, e); res.status(500).json({error:"internal"}); }
}

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
