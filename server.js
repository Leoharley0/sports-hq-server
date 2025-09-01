// server.js — v19: Strict status gating + deterministic ordering.
// Priority: Finals(≤15m) → Live → Scheduled
// Live sorted by soonest-to-finish (start + expectedDuration), Scheduled by soonest-to-start.

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v19 (strict status + stable ordering)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

// Polyfill fetch for Node < 18
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ===== ENV KEYS =====
const V2_KEY = process.env.TSDB_V2_KEY || ""; // v2 livescore header
const V1_KEY = process.env.TSDB_V1_KEY || ""; // v1 path key (falls back to public "3")
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY missing (live may be limited)");
if (!V1_KEY) console.warn("ℹ️ TSDB_V1_KEY missing; using shared/test key");

// ===== CONFIG =====
const DEFAULT_COUNT = 10;               // rows per board
const TTL = {
  LIVE:   15_000,
  NEXT:   5 * 60_000,
  SEASON: 6 * 60 * 60_000,
  DAY:    30 * 60_000,
  PAST:   10 * 60_000,
  OUT:    60_000,
};
const SWR_EXTRA = 5 * 60_000;
const FINAL_KEEP_MS = 15 * 60 * 1000;

// Expected durations (very rough, but enough to sort live games “closest to finish”)
const SPORT_EXPECTED_MIN = {
  basketball:        135,  // NBA ~2.25h
  ice_hockey:        150,  // NHL ~2.5h
  american_football: 195,  // NFL ~3.25h
  baseball:          210,  // MLB highly variable; use 3.5h
};

// ===== Cache + in-flight dedupe =====
const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
const cache    = new Map(); // key -> {val,exp,swr}
const inflight = new Map(); // key -> Promise

function getCache(key){
  const e = cache.get(key);
  if (!e) return {hit:false};
  const now = Date.now();
  if (now <= e.exp) return {hit:true, fresh:true,  val:e.val};
  if (now <= e.swr) return {hit:true, fresh:false, val:e.val};
  return {hit:false};
}
function setCache(key,val,ttl){
  const now = Date.now();
  cache.set(key, { val, exp: now + ttl, swr: now + ttl + SWR_EXTRA });
}
async function withInflight(key, fn){
  if (inflight.has(key)) return inflight.get(key);
  const p = (async()=>{ try{ return await fn(); } finally{ inflight.delete(key); } })();
  inflight.set(key,p); return p;
}

// ===== robust fetch with 429 backoff =====
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const jitter = ms => ms + Math.floor(Math.random() * (ms/3));

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
        await sleep(wait); continue;
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
  const fetcher = async ()=>{ const j = await fetchJsonRetry(url, extra); if (j) setCache(key,j,ttl); return j || c.val || null; };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ===== time + status helpers =====
function cleanTime(t){ if(!t) return "00:00:00"; const s=String(t).trim(); return (/^tba$|^tbd$/i.test(s))?"00:00:00":s; }
function toMillis(d,t){ if(!d) return NaN; const tt=cleanTime(t); const hasTZ=/[zZ]$|[+\-]\d\d:?\d\d$/.test(tt); const ms=Date.parse(`${d}T${tt}${hasTZ?"":"Z"}`); return Number.isNaN(ms)?NaN:ms; }
function eventMillis(m){
  let ms = toMillis(m.dateEvent, m.strTime); if (!Number.isNaN(ms)) return ms;
  ms = toMillis(m.dateEventLocal||m.dateEvent, m.strTimeLocal||m.strTime); if (!Number.isNaN(ms)) return ms;
  if (m.strTimestampMS){ const n=+m.strTimestampMS; if (!Number.isNaN(n)) return n; }
  if (m.strTimestamp){   const n=+m.strTimestamp*1000; if (!Number.isNaN(n)) return n; }
  if (m.dateEvent){      ms = toMillis(m.dateEvent, "00:00:00Z"); if (!Number.isNaN(ms)) return ms; }
  if (m.dateEventLocal){ ms = toMillis(m.dateEventLocal, "00:00:00Z"); if (!Number.isNaN(ms)) return ms; }
  return NaN;
}
function pickScore(v){ return (v===undefined||v===null||v===""||v==="N/A")?null:v; }
function isLiveWord(s=""){ s=(s+"").toLowerCase(); return s.includes("live")||s.includes("in play")||s.includes("half")||s==="ht"||s.includes("ot")||/^q\d/.test(s)||s.includes("quarter")||s.includes("period"); }
function isFinalWord(s=""){ s=(s+"").toLowerCase(); return s.includes("final")||s==="ft"||s.includes("full time")||s.includes("ended")||s.includes("finished"); }

// **Strict** status gating
function strongStatus(m, sport){
  const now = Date.now();
  const raw  = (m.strStatus || m.strProgress || "").trim();
  const s1 = pickScore(m.intHomeScore ?? m.intHomeGoals);
  const s2 = pickScore(m.intAwayScore ?? m.intAwayGoals);
  const ms = eventMillis(m);

  // If we know it finished, call it Final
  if (isFinalWord(raw) || ((s1!==null || s2!==null) && isFinite(ms) && now - ms > 5*60*1000)) return "Final";

  // If we know the game hasn't started yet, force Scheduled (even if upstream says "Live")
  if (isFinite(ms) && ms > now + 60*1000) return "Scheduled";

  // If we're within the start window, treat as LIVE only with a positive signal
  if (isFinite(ms) && now >= ms - 60*1000) {
    if (isLiveWord(raw) || s1!==null || s2!==null) return "LIVE";
    return "Scheduled";
  }

  // Fallback: words (rare)
  if (isLiveWord(raw))  return "LIVE";
  if (isFinalWord(raw)) return "Final";
  return "Scheduled";
}

function statusGroup(m, sport){
  const st = strongStatus(m, sport);
  return st === "Final" ? 0 : st === "LIVE" ? 1 : 2;
}

function liveETA(m, sport){
  const ms = eventMillis(m);
  const now = Date.now();
  const durMin = SPORT_EXPECTED_MIN[sport] || 150;
  if (!isFinite(ms)) return Number.POSITIVE_INFINITY;
  return (ms + durMin*60*1000) - now; // smaller means closer to finish
}

function sortForDisplay(a,b, sport){
  const ga = statusGroup(a, sport);
  const gb = statusGroup(b, sport);
  if (ga !== gb) return ga - gb; // Finals → Live → Scheduled

  const ta = eventMillis(a);
  const tb = eventMillis(b);

  if (ga === 0) { // Finals: newest first
    return (isFinite(tb)?tb:0) - (isFinite(ta)?ta:0);
  }
  if (ga === 1) { // Live: soonest to finish
    return liveETA(a, sport) - liveETA(b, sport);
  }
  // Scheduled: earliest start first
  return (isFinite(ta)?ta:Number.POSITIVE_INFINITY) - (isFinite(tb)?tb:Number.POSITIVE_INFINITY);
}

function isRecentFinal(m){
  const raw = m.strStatus || m.strProgress || "";
  if (!isFinalWord(raw)) return false;
  const ms = eventMillis(m); if (!isFinite(ms)) return false;
  return (Date.now() - ms) <= FINAL_KEEP_MS;
}

// ===== TSDB wrappers =====
async function v2Livescore(sport){
  const s=sport.replace(/_/g," ");
  const urls=[
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out=[];
  for (const u of urls){
    const j = await memoJson(u, TTL.LIVE, V2_KEY ? {"X-API-KEY":V2_KEY} : {});
    if (j?.livescore?.length) out.push(...j.livescore);
  }
  return out;
}
const V1 = (p)=>`https://www.thesportsdb.com/api/v1/json/${V1_KEY || "3"}/${p}`;
async function v1NextLeague(id){ const j=await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(V1(`eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`), TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }
const SPORT_LABEL={ soccer:"Soccer", basketball:"Basketball", american_football:"American Football", ice_hockey:"Ice Hockey", baseball:"Baseball" };
async function v1EventsDay(sport, ymd){
  const label=SPORT_LABEL[sport]||sport;
  const j=await memoJson(V1(`eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`), TTL.DAY);
  return Array.isArray(j?.events)?j.events:[]; // not used for MLB in your setup, but left available
}

// ===== Seasons (same as before) =====
function guessSeasonCrossYear(){ const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1; const start=(m>=7)?y:y-1; return `${start}-${start+1}`; }
function seasonsCrossTriple(){ const c=guessSeasonCrossYear(); const prev=`${parseInt(c)-1}-${parseInt(c)}`; const next=`${parseInt(c)+1}-${parseInt(c)+2}`; return [c, next, prev]; }
function seasonsNFL(){ const y=(new Date()).getUTCFullYear(); const c=guessSeasonCrossYear(); return [String(y), String(y+1), c, `${parseInt(c)-1}-${parseInt(c)}`]; }

// ===== leagues =====
const L = {
  NBA: 4387,
  NFL: 4391,
  NHL: 4380,
  MLB: 4424, // TheSportsDB MLB
};

// ===== formatting to client (keep same shape) =====
function formatMatch(m, sport){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"";
  const away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=pickScore(m.intHomeScore??m.intHomeGoals);
  const s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const status=strongStatus(m, sport);
  const ms=eventMillis(m);
  return {
    team1:home, team2:away,
    score1:s1===null?"N/A":String(s1),
    score2:s2===null?"N/A":String(s2),
    headline:`${home} vs ${away} - ${status}`,
    start:isFinite(ms)?new Date(ms).toISOString():null
  };
}

// ===== board builders (unchanged sources; new gating & sorting apply) =====
async function buildSingle({ sport, leagueId, seasons, n }){
  const finals=[], live=[], sched=[];
  const now = Date.now();

  // Recent finals
  const past = await v1PastLeague(leagueId);
  for (const m of (past||[])) if (isRecentFinal(m)) finals.push(m);

  // Live
  const ls = await v2Livescore(sport);
  for (const m of (ls||[])) if (String(m.idLeague||"")===String(leagueId) && strongStatus(m, sport)==="LIVE") live.push(m);

  // Upcoming (cheap → richer)
  const next = (await v1NextLeague(leagueId)).sort((a,b)=>eventMillis(a)-eventMillis(b));
  for (const m of next){ if (sched.length + finals.length + live.length >= n) break; if (isFinite(eventMillis(m)) && eventMillis(m) >= now) sched.push(m); }

  // Seasons (optional topup if still short)
  if (finals.length + live.length + sched.length < n){
    for (const s of seasons){
      const rows = await v1Season(leagueId, s);
      const fut  = (rows||[]).filter(x => isFinite(eventMillis(x)) && eventMillis(x)>=now)
                             .sort((a,b)=>eventMillis(a)-eventMillis(b));
      for (const m of fut){ if (finals.length + live.length + sched.length >= n) break; sched.push(m); }
      if (finals.length + live.length + sched.length >= n) break;
    }
  }

  const merged = [...finals, ...live, ...sched].sort((a,b)=>sortForDisplay(a,b,sport)).slice(0,n);
  return merged;
}

// ===== cached wrappers =====
async function getBoardCached(key, builder){
  const c=getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const data=await builder(); setCache(key,data,TTL.OUT); return data; };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ===== routes =====
app.get("/scores/nba", async (req,res)=>serveSingle(req,res,"basketball",        L.NBA, seasonsCrossTriple()));
app.get("/scores/nfl", async (req,res)=>serveSingle(req,res,"american_football", L.NFL, seasonsNFL()));
app.get("/scores/nhl", async (req,res)=>serveSingle(req,res,"ice_hockey",        L.NHL, seasonsCrossTriple()));
app.get("/scores/baseball", async (req,res)=>serveSingle(req,res,"baseball",     L.MLB, seasonsCrossTriple()));

async function serveSingle(req,res,sport,leagueId,seasons){
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const items = await getBoardCached(`OUT:${sport}:${leagueId}:${n}`, () =>
      buildSingle({ sport, leagueId, seasons, n })
    );
    res.json(items.map(m => formatMatch(m, sport)));
  }catch(e){ console.error(`${sport} error:`, e); res.status(500).json({error:"internal"}); }
}

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
