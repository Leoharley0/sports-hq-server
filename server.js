// server.js — Simple 3+1 v2 + DEBUG route
// Order: Finals(≤15m) → Live → Scheduled (soonest). Season backfill, strong SWR.
// Debug route: /debug/:board  (soccer|nfl|nba|nhl) — reports upstream availability.

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ simple-3+1 v2 + debug";
app.get("/version", (_, res) => res.json({ build: BUILD }));

// fetch polyfill for Node < 18
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

/* ---------- config ---------- */
const L = { EPL: 4328, NBA: 4387, NFL: 4391, NHL: 4380 };
const SPORT_LABEL = { soccer: "Soccer", basketball: "Basketball", american_football: "American Football", ice_hockey: "Ice Hockey" };

const DEFAULT_N = 10;

// EPL backfill days (Fri–Mon) & horizon
const EPL_DOW   = [5, 6, 0, 1];
const EPL_WEEKS = 4;                 // ~16 day calls max (cached 30m)

// NFL backfill days (Thu/Sat/Sun/Mon) & horizon
const NFL_DOW   = [4, 6, 0, 1];
const NFL_WEEKS = 4;

// NBA/NHL backfill: next 3 weeks (all days)
const DAILY_DOW   = [0,1,2,3,4,5,6];
const DAILY_WEEKS = 3;

const TTL = {
  LIVE:   15_000,       // livescore refresh
  NEXT:    5*60_000,    // next-league
  PAST:   10*60_000,    // recent finals
  DAY:    30*60_000,    // eventsday
  SEASON:  6*60*60_000, // eventsseason (very long)
  OUT:     90_000       // final board response TTL
};
const SWR_EXTRA = 5 * 60_000;

const V2_KEY = process.env.TSDB_V2_KEY || "";
const V1_KEY = process.env.TSDB_V1_KEY || "";
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY missing; live may be limited");
if (!V1_KEY) console.warn("ℹ️ TSDB_V1_KEY missing; using shared key");

/* ---------- utils ---------- */
const COMMON_HEADERS = { "User-Agent": "SportsHQ/1.0 (+render.com)", "Accept": "application/json" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = ms => ms + Math.floor(Math.random() * (ms/3));

const cache = new Map();   // key -> {val, exp, swr}
const inflight = new Map();

function getC(key){
  const e = cache.get(key);
  if (!e) return {hit:false};
  const now = Date.now();
  if (now <= e.exp) return {hit:true, fresh:true,  val:e.val};
  if (now <= e.swr) return {hit:true, fresh:false, val:e.val};
  return {hit:false};
}
function setC(key, val, ttl){
  const now = Date.now();
  cache.set(key, { val, exp: now + ttl, swr: now + ttl + SWR_EXTRA });
}
async function withInflight(key, fn){
  if (inflight.has(key)) return inflight.get(key);
  const p = (async ()=>{ try { return await fn(); } finally { inflight.delete(key); } })();
  inflight.set(key, p); return p;
}

async function fetchJsonRetry(url, extra={}, tries=4, baseDelay=650){
  let last;
  for (let i=0;i<tries;i++){
    try{
      const res = await fetch(url, { headers: { ...COMMON_HEADERS, ...extra } });
      const txt = await res.text();
      if (res.status === 429){
        const ra = Number(res.headers?.get("retry-after"))||0;
        const wait = jitter(ra ? ra*1000 : baseDelay*Math.pow(2,i));
        console.warn(`[429] wait ${wait}ms :: ${url}`);
        await sleep(wait); continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} | ${txt.slice(0,160)}`);
      return JSON.parse(txt);
    }catch(e){
      last = e;
      const wait = jitter(baseDelay*Math.pow(2,i));
      console.warn(`[retry] ${e.message}; wait ${wait}ms :: ${url}`);
      await sleep(wait);
    }
  }
  console.error(`[FAIL] ${last?.message} :: ${url}`);
  return null;
}
async function memoJson(url, ttl, extra={}){
  const k = `URL:${url}`;
  const c = getC(k);
  if (c.hit && c.fresh) return c.val;
  const fetcher = async ()=>{ const j = await fetchJsonRetry(url, extra); if (j) setC(k,j,ttl); return j || c.val || null; };
  if (c.hit && !c.fresh){ withInflight(k, fetcher); return c.val; }
  return withInflight(k, fetcher);
}

/* ---------- TSDB wrappers ---------- */
const V1 = p => `https://www.thesportsdb.com/api/v1/json/${V1_KEY||"3"}/${p}`;

async function v1PastLeague(id)   { const j = await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST);   return Array.isArray(j?.events)?j.events:[]; }
async function v1NextLeague(id)   { const j = await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT);   return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s)     { const j = await memoJson(V1(`eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`), TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1EventsDay(sport, ymd){
  const label = SPORT_LABEL[sport] || sport;
  const j = await memoJson(V1(`eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`), TTL.DAY);
  return Array.isArray(j?.events)?j.events:[];
}
async function v2Livescore(sport){
  const s = sport.replace(/_/g," ");
  const urls = [
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out = [];
  for (const u of urls){
    const j = await memoJson(u, TTL.LIVE, V2_KEY?{"X-API-KEY":V2_KEY}:{});
    if (Array.isArray(j?.livescore)) out.push(...j.livescore);
  }
  return out;
}

/* ---------- time/status ---------- */
function pickScore(v){ return (v===undefined||v===null||v===""||v==="N/A")?null:v; }
function isLiveWord(s=""){ s=(s+"").toLowerCase(); return s.includes("live")||s.includes("in play")||s.includes("half")||s==="ht"||s.includes("ot"); }
function isFinalWord(s=""){ s=(s+"").toLowerCase(); return s.includes("final")||s==="ft"||s.includes("full time"); }
function isTBA(t){ if(!t) return true; const s=String(t).trim().toLowerCase(); return !s||s==="tba"||s==="tbd"||s==="ns"||s.startsWith("00:00:00"); }

function parseMs(x){
  if (x==null) return NaN;
  if (typeof x==="number") return Number.isFinite(x)?(x>1e12?x:x*1000):NaN;
  const s=String(x).trim();
  if (/^\d{13}$/.test(s)) return +s;
  if (/^\d{10}$/.test(s))  return +s*1000;
  const d=Date.parse(s);   if (Number.isFinite(d)) return d;
  return NaN;
}

function eventMillis(m){
  const combo=(d,t)=>{
    if (!d) return {ms:NaN, dateOnly:false, ymd:""};
    const ds=String(d).trim(), ymd=ds.slice(0,10);
    if (isTBA(t)) return {ms:parseMs(ds)||Date.parse(`${ymd}T12:00:00Z`), dateOnly:true, ymd};
    const tt=String(t).trim().replace(/([+\-]\d{2})(\d{2})$/,"$1:$2");
    const iso=/[Zz]|[+\-]\d{2}:\d{2}$/.test(tt)?`${ds}T${tt}`:`${ds}T${tt}Z`;
    const ms=Date.parse(iso); return {ms, dateOnly:false, ymd};
  };
  let r=combo(m.dateEvent, m.strTime); if (Number.isFinite(r.ms)) return r;
  r=combo(m.dateEventLocal||m.dateEvent, m.strTimeLocal||m.strTime); if (Number.isFinite(r.ms)) return r;
  const ms=parseMs(m.strTimestampMS)||parseMs(m.strTimestamp); if (Number.isFinite(ms)) return {ms, dateOnly:false, ymd:new Date(ms).toISOString().slice(0,10)};
  return {ms:NaN, dateOnly:false, ymd:""};
}

function futureOK(ev, now){
  const {ms,dateOnly,ymd} = eventMillis(ev);
  if (Number.isFinite(ms) && ms >= now) return true;
  if (dateOnly) { const today=new Date(now).toISOString().slice(0,10); return ymd >= today; }
  return false;
}

const FINAL_KEEP_MS = 15*60*1000;
function isRecentFinal(m){ const raw=m.strStatus||m.strProgress||""; if (!isFinalWord(raw)) return false; const t=eventMillis(m).ms; return Number.isFinite(t)&&(Date.now()-t)<=FINAL_KEEP_MS; }

function statusOf(m){ const s1=pickScore(m.intHomeScore??m.intHomeGoals), s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const raw=String(m.strStatus||m.strProgress||"").trim(); if (isFinalWord(raw)) return "Final"; if (isLiveWord(raw)) return (s1!==null||s2!==null)?"LIVE":"Scheduled"; return "Scheduled"; }

function pushUnique(arr,m){
  const k = m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`;
  if (arr.some(x => (x.idEvent || `${x.strHomeTeam}|${x.strAwayTeam}|${x.dateEvent||x.dateEventLocal||""}`) === k)) return false;
  arr.push(m); return true;
}

function sortForDisplay(a,b){
  const R = s => s==="Final" ? 0 : s==="LIVE" ? 1 : 2;
  const sa=statusOf(a), sb=statusOf(b);
  if (R(sa)!==R(sb)) return R(sa)-R(sb);
  const ta=eventMillis(a).ms, tb=eventMillis(b).ms;
  const aBad=!Number.isFinite(ta), bBad=!Number.isFinite(tb);
  if (aBad && !bBad) return +1; if (!aBad && bBad) return -1;
  if (sa==="Final") return tb-ta;
  return ta-tb;
}

/* ---------- tiny day sweep ---------- */
function sweepDates(weeks, dows){
  const out = new Set();
  const now = new Date();
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0,0,0);
  for (let w=0; w<weeks; w++){
    for (const dow of dows){
      const d = new Date(base + w*7*864e5);
      const delta = (dow - d.getUTCDay() + 7) % 7;
      const ts = new Date(base + (w*7+delta)*864e5).toISOString().slice(0,10);
      out.add(ts);
    }
  }
  return Array.from(out).sort();
}

/* ---------- season helpers ---------- */
function crossYearNow(){ const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1; const start=(m>=7)?y:y-1; return `${start}-${start+1}`; }
function seasonCandidates(sport, leagueId){
  const y=(new Date()).getUTCFullYear(), cross=crossYearNow();
  if (leagueId===L.NFL) return [String(y), String(y+1), String(y-1)];
  return [cross, `${y}-${y+1}`, `${y-1}-${y}`];
}
async function seasonBackfill({ sport, leagueId, out, n }){
  const now = Date.now();
  for (const s of seasonCandidates(sport, leagueId)){
    const rows = await v1Season(leagueId, s);
    const fut = (rows||[])
      .filter(m => futureOK(m, now))
      .sort((a,b)=>eventMillis(a).ms - eventMillis(b).ms);
    for (const m of fut){
      if (out.length >= n) break;
      pushUnique(out, m);
    }
    if (out.length >= n) break;
  }
}

/* ---------- the generic builder ---------- */
async function buildBoard({ sport, leagueId, n, backfillWeeks, backfillDOW }) {
  const now = Date.now();
  const finals = [], live = [], sched = [];

  // 1) recent finals
  const past = await v1PastLeague(leagueId);
  for (const m of (past||[])) if (isRecentFinal(m)) pushUnique(finals, m);
  finals.sort((a,b)=>eventMillis(b).ms - eventMillis(a).ms);

  // 2) live
  const ls = await v2Livescore(sport);
  for (const m of (ls||[])) if (String(m.idLeague||"")===String(leagueId) && !isRecentFinal(m)) pushUnique(live, m);

  // 3) next-league
  const next = await v1NextLeague(leagueId);
  const futNext = (next||[]).filter(m=>futureOK(m, now)).sort((a,b)=>eventMillis(a).ms - eventMillis(b).ms);
  for (const m of futNext){ if (finals.length+live.length+sched.length >= n) break; pushUnique(sched, m); }

  // tiny day sweep
  if (finals.length+live.length+sched.length < n){
    const dates = sweepDates(backfillWeeks, backfillDOW);
    for (const ymd of dates){
      if (finals.length+live.length+sched.length >= n) break;
      const rows = await v1EventsDay(sport, ymd);
      const fut = (rows||[])
        .filter(m => String(m.idLeague||"")===String(leagueId))
        .filter(m => futureOK(m, now))
        .sort((a,b)=>eventMillis(a).ms - eventMillis(b).ms);
      for (const m of fut){
        if (finals.length+live.length+sched.length >= n) break;
        pushUnique(sched, m);
      }
    }
  }

  // season backfill (single, long-TTL) — guarantees fill without hammering
  if (finals.length+live.length+sched.length < n){
    await seasonBackfill({ sport, leagueId, out: sched, n: n - (finals.length+live.length) });
  }

  const out = [...finals, ...live, ...sched].sort(sortForDisplay).slice(0, n);
  console.log(`[${sport}:${leagueId}] F=${finals.length} L=${live.length} S=${sched.length} -> out=${out.length}`);
  return out;
}

/* ---------- strong SWR wrapper ---------- */
async function getBoardCached(key, ttl, builder){
  const c = getC(key);
  if (c.hit && c.fresh) return c.val;

  const fetcher = async ()=>{
    const data = await builder();
    // If new data is shorter than last known board, keep the longer one
    if (c.hit && Array.isArray(c.val) && (data?.length||0) < (c.val?.length||0)) {
      setC(key, c.val, ttl);   // keep serving the longer board
      return c.val;
    }
    setC(key, data || [], ttl);
    return data || [];
  };

  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

/* ---------- formatter ---------- */
function fmt(m){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"";
  const away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=pickScore(m.intHomeScore??m.intHomeGoals);
  const s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const status=statusOf(m);
  const ms=eventMillis(m).ms;
  return { team1:home, team2:away, score1:s1===null?"N/A":String(s1), score2:s2===null?"N/A":String(s2),
           headline:`${home} vs ${away} - ${status}`, start:Number.isFinite(ms)?new Date(ms).toISOString():null };
}

/* ---------- routes (UNCHANGED logic) ---------- */
// Soccer = EPL only
app.get("/scores/soccer", async (req,res)=>{
  const n = Math.max(5, Math.min(10, parseInt(req.query.n||DEFAULT_N,10)||DEFAULT_N));
  const key = `OUT:soccer:${L.EPL}:${n}:v2`;
  const rows = await getBoardCached(key, TTL.OUT, ()=>buildBoard({
    sport: "soccer", leagueId: L.EPL, n,
    backfillWeeks: EPL_WEEKS, backfillDOW: EPL_DOW
  }));
  res.json(rows.map(fmt));
});

// NFL
app.get("/scores/nfl", async (req,res)=>{
  const n = Math.max(5, Math.min(10, parseInt(req.query.n||DEFAULT_N,10)||DEFAULT_N));
  const key = `OUT:nfl:${L.NFL}:${n}:v2`;
  const rows = await getBoardCached(key, TTL.OUT, ()=>buildBoard({
    sport: "american_football", leagueId: L.NFL, n,
    backfillWeeks: NFL_WEEKS, backfillDOW: NFL_DOW
  }));
  res.json(rows.map(fmt));
});

// NBA
app.get("/scores/nba", async (req,res)=>{
  const n = Math.max(5, Math.min(10, parseInt(req.query.n||DEFAULT_N,10)||DEFAULT_N));
  const key = `OUT:nba:${L.NBA}:${n}:v2`;
  const rows = await getBoardCached(key, TTL.OUT, ()=>buildBoard({
    sport: "basketball", leagueId: L.NBA, n,
    backfillWeeks: DAILY_WEEKS, backfillDOW: DAILY_DOW
  }));
  res.json(rows.map(fmt));
});

// NHL
app.get("/scores/nhl", async (req,res)=>{
  const n = Math.max(5, Math.min(10, parseInt(req.query.n||DEFAULT_N,10)||DEFAULT_N));
  const key = `OUT:nhl:${L.NHL}:${n}:v2`;
  const rows = await getBoardCached(key, TTL.OUT, ()=>buildBoard({
    sport: "ice_hockey", leagueId: L.NHL, n,
    backfillWeeks: DAILY_WEEKS, backfillDOW: DAILY_DOW
  }));
  res.json(rows.map(fmt));
});

/* ---------- PT1: DEBUG route (NEW) ---------- */
app.get("/debug/:board", async (req, res) => {
  try {
    const name = String(req.params.board || "").toLowerCase();
    const map = {
      soccer: { sport: "soccer",            leagueId: L.EPL, label: "Soccer",            dow: EPL_DOW, weeks: EPL_WEEKS },
      nfl:    { sport: "american_football", leagueId: L.NFL, label: "American Football", dow: NFL_DOW, weeks: NFL_WEEKS },
      nba:    { sport: "basketball",        leagueId: L.NBA, label: "Basketball",        dow: DAILY_DOW, weeks: DAILY_WEEKS },
      nhl:    { sport: "ice_hockey",        leagueId: L.NHL, label: "Ice Hockey",        dow: DAILY_DOW, weeks: DAILY_WEEKS },
    };
    const cfg = map[name];
    if (!cfg) return res.status(400).json({ error: "unknown board" });

    const now = Date.now();
    const past = await v1PastLeague(cfg.leagueId);
    const finalsRecent = (past||[]).filter(isRecentFinal);

    const liveAll = await v2Livescore(cfg.sport);
    const liveThis = (liveAll||[]).filter(m => String(m.idLeague||"") === String(cfg.leagueId));

    const next = await v1NextLeague(cfg.leagueId);
    const nextFuture = (next||[]).filter(m => futureOK(m, now));

    const dates = sweepDates(cfg.weeks, cfg.dow);
    let dayCalls = 0, dayRaw = 0, dayKept = 0;
    for (const ymd of dates){
      const rows = await v1EventsDay(cfg.sport, ymd); dayCalls++; dayRaw += (rows?.length||0);
      const kept = (rows||[]).filter(m => String(m.idLeague||"")===String(cfg.leagueId))
                             .filter(m => futureOK(m, now));
      dayKept += kept.length;
    }

    let seasonRaw = 0, seasonFuture = 0;
    for (const s of seasonCandidates(cfg.sport, cfg.leagueId)){
      const rows = await v1Season(cfg.leagueId, s); seasonRaw += (rows?.length||0);
      seasonFuture += (rows||[]).filter(m => futureOK(m, now)).length;
    }

    res.json({
      board: name,
      leagueId: cfg.leagueId,
      counts: {
        past_all: (past||[]).length,
        finals_recent: finalsRecent.length,
        live_allSports: (liveAll||[]).length,
        live_thisLeague: liveThis.length,
        next_all: (next||[]).length,
        next_future: nextFuture.length,
        day_calls: dayCalls,
        day_raw: dayRaw,
        day_kept_future: dayKept,
        season_raw: seasonRaw,
        season_future: seasonFuture,
      },
      notes: "Reports upstream availability only — does not build the board."
    });
  } catch (e) {
    console.error("DEBUG route error:", e);
    res.status(500).json({ error: "debug-failed" });
  }
});

/* ---------- health ---------- */
app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));

