// server.js — v20: robust time parsing + canonical status, 10 rows per board,
// order = Finals (≤15m) → Live (soonest) → Scheduled (soonest). SWR + gentle retries.

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v20 (robust time + server status + SWR)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

// Polyfill fetch for Node < 18
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ───────────────────────────────────────────────────────────────────────────────
// ENV
// ───────────────────────────────────────────────────────────────────────────────
const V2_KEY = process.env.TSDB_V2_KEY || ""; // v2 livescore header
const V1_KEY = process.env.TSDB_V1_KEY || ""; // v1 path key (falls back to public "3")
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY missing (v2/live may be limited)");
if (!V1_KEY) console.warn("ℹ️ TSDB_V1_KEY missing; using shared/test key");

// ───────────────────────────────────────────────────────────────────────────────
// Tunables
// ───────────────────────────────────────────────────────────────────────────────
const DEFAULT_COUNT = 10;

const TTL = {
  LIVE:   15_000,          // v2 livescore is volatile
  NEXT:   5 * 60_000,
  SEASON: 6 * 60 * 60_000,
  DAY:    30 * 60_000,
  PAST:   10 * 60_000,
  OUT:    60_000,          // response cache TTL (SWR will refresh in background)
};
const SWR_EXTRA = 5 * 60_000; // serve stale-while-revalidate window

// Day scanning throttle (soft)
const DAY_TOKENS_MAX = 80;
let DAY_TOKENS = DAY_TOKENS_MAX;
setInterval(() => { DAY_TOKENS = Math.min(DAY_TOKENS_MAX, DAY_TOKENS + 4); }, 10_000);

// ───────────────────────────────────────────────────────────────────────────────
// SWR cache + in-flight dedupe
// ───────────────────────────────────────────────────────────────────────────────
const cache = new Map();    // key -> { val, exp, swr }
const inflight = new Map(); // key -> Promise

function getCache(key) {
  const e = cache.get(key);
  if (!e) return { hit:false };
  const now = Date.now();
  if (now <= e.exp) return { hit:true, fresh:true,  val:e.val };
  if (now <= e.swr) return { hit:true, fresh:false, val:e.val };
  return { hit:false };
}
function setCache(key, val, ttl) {
  const now = Date.now();
  cache.set(key, { val, exp: now + ttl, swr: now + ttl + SWR_EXTRA });
}
async function withInflight(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => { try { return await fn(); } finally { inflight.delete(key); } })();
  inflight.set(key, p); return p;
}

// ───────────────────────────────────────────────────────────────────────────────
// Fetch with gentle retry/backoff (429-aware)
// ───────────────────────────────────────────────────────────────────────────────
const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = ms => ms + Math.floor(Math.random() * (ms/3));

async function fetchJsonRetry(url, extra={}, tries=4, baseDelay=750) {
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

async function memoJson(url, ttl, extra={}) {
  const key = `URL:${url}`;
  const c = getCache(key);
  if (c.hit && c.fresh) return c.val;

  const fetcher = async () => {
    const j = await fetchJsonRetry(url, extra);
    if (j) setCache(key, j, ttl);
    return j || c.val || null;
  };
  if (c.hit && !c.fresh) { withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ───────────────────────────────────────────────────────────────────────────────
// Time / status helpers (robust time so sort is correct on the same day)
// ───────────────────────────────────────────────────────────────────────────────
function parseFlexibleClock(str) {
  if (!str) return null;
  let s = String(str).trim();
  if (!s || /^tba|tbd|00:00(?::00)?$/i.test(s)) return null;

  // Normalize
  s = s
    .replace(/\s*(UTC|UT|Z)$/i, "Z")
    .replace(/\.\d{3}Z$/i, "Z")
    .replace(/\s*([AP])\.?M\.?$/i, " $1M");  // "9:05pm" → "9:05 PM"

  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return s.length === 5 ? s + ":00" : s;    // "21:05"
  if (/^\d{1,2}:\d{2}\s*[AP]M$/i.test(s)) return s.toUpperCase();                   // "9:05 PM"
  return s; // ISO-ish with TZ
}

function eventMillis(m) {
  // Prefer explicit timestamps
  const tsms = +m.strTimestampMS;
  if (Number.isFinite(tsms) && tsms > 0) return tsms;

  const tss = +m.strTimestamp;
  if (Number.isFinite(tss) && tss > 0) return tss * 1000;

  // Compose from date + time
  const date = m.dateEventLocal || m.dateEvent;
  const clockRaw = m.strTimeLocal || m.strTime;
  if (date) {
    const clock = parseFlexibleClock(clockRaw);
    if (clock) {
      const hasTZ = /[zZ]$|[+\-]\d\d:?\d\d$/.test(clock);
      const iso = `${date}T${clock}${hasTZ ? "" : "Z"}`;
      const ms = Date.parse(iso);
      if (Number.isFinite(ms)) return ms;
    }
    // Unknown time → place at noon for stable same-day ordering
    const noon = Date.parse(`${date}T12:00:00Z`);
    if (Number.isFinite(noon)) return noon;
  }
  return NaN;
}

function pickScore(v){ return (v===undefined||v===null||v===""||v==="N/A")?null:v; }
function isLiveWord(s=""){ s=(s+"").toLowerCase(); return s.includes("live")||s.includes("in play")||s.includes("half")||s==="ht"||s.includes("ot")||/^q\d/.test(s); }
function isFinalWord(s=""){ s=(s+"").toLowerCase(); return s.includes("final")||s==="ft"||s.includes("full time"); }

function normalizeStatus(m, s1, s2) {
  const raw = String(m.strStatus || m.strProgress || "").trim();
  const hasScore = (s1!==null) || (s2!==null);
  if (isFinalWord(raw)) return "Final";
  if (isLiveWord(raw))  return hasScore ? "LIVE" : "Scheduled";
  if (!raw || raw==="NS" || raw.toLowerCase()==="scheduled" || raw.toLowerCase()==="preview") return "Scheduled";
  return hasScore ? raw : "Scheduled";
}

const FINAL_KEEP_MS = 15*60*1000; // keep finals for 15 minutes
function isRecentFinal(m){
  const raw = m.strStatus || m.strProgress || "";
  if (!isFinalWord(raw)) return false;
  const ms = eventMillis(m);
  if (!Number.isFinite(ms)) return false;
  return (Date.now() - ms) <= FINAL_KEEP_MS;
}

function computedStatus(m){
  const s1 = pickScore(m.intHomeScore??m.intHomeGoals);
  const s2 = pickScore(m.intAwayScore??m.intAwayGoals);
  return normalizeStatus(m, s1, s2);
}

function matchKey(m){ return m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`; }
function pushUnique(arr,m){ const k=matchKey(m); if(!arr.some(x=>matchKey(x)===k)) arr.push(m); }

function sortForDisplay(a,b){
  const rank = s => s==="Final"?0 : s==="LIVE"?1 : 2;
  const sa = computedStatus(a), sb = computedStatus(b);
  if (rank(sa) !== rank(sb)) return rank(sa) - rank(sb);

  const ta = eventMillis(a), tb = eventMillis(b);
  const aBad = !Number.isFinite(ta), bBad = !Number.isFinite(tb);
  if (aBad && !bBad) return +1;
  if (!aBad && bBad) return -1;

  if (sa === "Final") return tb - ta; // most recently finished first
  return ta - tb;                     // live/scheduled: soonest first
}

// ───────────────────────────────────────────────────────────────────────────────
// TSDB helpers
// ───────────────────────────────────────────────────────────────────────────────
const SPORT_LABEL = {
  soccer:            "Soccer",
  basketball:        "Basketball",
  american_football: "American Football",
  ice_hockey:        "Ice Hockey",
  baseball:          "Baseball",
};

const V1 = p => `https://www.thesportsdb.com/api/v1/json/${V1_KEY || "3"}/${p}`;

async function v2Livescore(sport){
  const s = sport.replace(/_/g," ");
  const urls = [
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out = [];
  for (const u of urls){
    const j = await memoJson(u, TTL.LIVE, V2_KEY ? {"X-API-KEY":V2_KEY} : {});
    if (j?.livescore?.length) out.push(...j.livescore);
  }
  return out;
}
async function v1NextLeague(id){ const j=await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(V1(`eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`), TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }
async function v1EventsDay(sport, ymd){
  const label = SPORT_LABEL[sport] || sport;
  const j = await memoJson(V1(`eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`), TTL.DAY);
  return Array.isArray(j?.events) ? j.events : [];
}

// ───────────────────────────────────────────────────────────────────────────────
// Seasons (basic candidates, we still rely mostly on day scans “soonest first”)
// ───────────────────────────────────────────────────────────────────────────────
function utcY(){ return (new Date()).getUTCFullYear(); }
function guessCross(){ const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1; const start=(m>=7)?y:y-1; return `${start}-${start+1}`; }

function seasonsFor(leagueId, sport){
  // NBA (4387), NHL (4380) are cross-year; NFL (4391) single-year; MLB (4424) single-year.
  const y = utcY();
  if (leagueId===4387 || leagueId===4380) {    // NBA/NHL
    const c = guessCross();
    const prev = `${parseInt(c)-1}-${parseInt(c)}`;
    return [c, prev];
  }
  // NFL/MLB
  return [String(y), String(y+1)];
}

// ───────────────────────────────────────────────────────────────────────────────
// Build a board: finals (recent) → live → scheduled (soonest first, up to n)
// ───────────────────────────────────────────────────────────────────────────────
async function buildBoard({ sport, leagueId, n }) {
  const finals=[], live=[], sched=[];
  const now = Date.now();

  // 1) RECENT FINALS (cheap)
  const past = await v1PastLeague(leagueId);
  for (const m of (past||[])) if (isRecentFinal(m)) pushUnique(finals, m);
  finals.sort((a,b)=>eventMillis(b)-eventMillis(a));

  // 2) LIVE (v2) filtered to league
  const ls = await v2Livescore(sport);
  for (const m of (ls||[])) if (String(m.idLeague||"")===String(leagueId) && !isRecentFinal(m)) pushUnique(live, m);

  // 3) UPCOMING — next (cheap)
  if (finals.length + live.length < n) {
    const next = (await v1NextLeague(leagueId)).sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of next) {
      if (finals.length + live.length + sched.length >= n) break;
      const ms = eventMillis(m); if (!Number.isFinite(ms) || ms < now) continue;
      pushUnique(sched, m);
    }
  }

  // 4) UPCOMING — season (a couple of candidate seasons)
  if (finals.length + live.length + sched.length < n) {
    for (const s of seasonsFor(leagueId, sport)) {
      const rows = await v1Season(leagueId, s);
      const fut = (rows||[])
        .filter(x => { const ms=eventMillis(x); return Number.isFinite(ms) && ms>=now; })
        .sort((a,b)=>eventMillis(a)-eventMillis(b));
      for (const m of fut) {
        if (finals.length + live.length + sched.length >= n) break;
        pushUnique(sched, m);
      }
      if (finals.length + live.length + sched.length >= n) break;
    }
  }

  // 5) UPCOMING — day scans (token-limited), look up to ~30 days
  let shortBy = n - (finals.length + live.length + sched.length);
  if (shortBy > 0 && DAY_TOKENS > 0) {
    const use = Math.min(DAY_TOKENS, Math.max(20, shortBy * 2));
    DAY_TOKENS -= use;

    const today = new Date(); let used=0;
    outer: for (let d=0; d<30; d++){
      if (used >= use) break;
      const ymd = new Date(today.getTime()+d*86400000).toISOString().slice(0,10);
      const rows = await v1EventsDay(sport, ymd); used++;
      const fut = (rows||[])
        .filter(m => String(m.idLeague||"")===String(leagueId))
        .filter(m => { const ms=eventMillis(m); return Number.isFinite(ms) && ms>=now; })
        .sort((a,b)=>eventMillis(a)-eventMillis(b));
      for (const m of fut) {
        if (finals.length + live.length + sched.length >= n) break outer;
        pushUnique(sched, m);
      }
    }
  }

  const merged = [...finals, ...live, ...sched].sort(sortForDisplay).slice(0, n);
  return merged;
}

// ───────────────────────────────────────────────────────────────────────────────
// Format output (send canonical status + full ISO start)
// ───────────────────────────────────────────────────────────────────────────────
function formatMatch(m){
  const home = m.strHomeTeam || m.homeTeam || m.strHome || "";
  const away = m.strAwayTeam || m.awayTeam || m.strAway || "";
  const s1   = pickScore(m.intHomeScore??m.intHomeGoals);
  const s2   = pickScore(m.intAwayScore??m.intAwayGoals);
  const st   = computedStatus(m);
  const ms   = eventMillis(m);

  return {
    team1: home,
    team2: away,
    score1: s1===null ? "N/A" : String(s1),
    score2: s2===null ? "N/A" : String(s2),
    status: st,
    start:  Number.isFinite(ms) ? new Date(ms).toISOString() : null,
    headline: `${home} vs ${away} - ${st}`,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Cached wrappers and routes
// ───────────────────────────────────────────────────────────────────────────────
async function getBoardCached(key, builder){
  const c = getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher = async () => { const data = await builder(); setCache(key, data, TTL.OUT); return data; };
  if (c.hit && !c.fresh) { withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// League IDs (TheSportsDB)
const L = {
  NBA: 4387,
  NFL: 4391,
  NHL: 4380,
  MLB: 4424, // Major League Baseball
};

function serveBoard(sport, leagueId){
  return async (req,res)=>{
    try{
      const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT,10) || DEFAULT_COUNT));
      const items = await getBoardCached(`OUT:${sport}:${leagueId}:${n}`, () =>
        buildBoard({ sport, leagueId, n })
      );
      res.json(items.map(formatMatch));
    }catch(e){
      console.error(`${sport} error:`, e);
      res.status(500).json({error:"internal"});
    }
  };
}

app.get("/scores/nba",       serveBoard("basketball",        L.NBA));
app.get("/scores/nfl",       serveBoard("american_football", L.NFL));
app.get("/scores/nhl",       serveBoard("ice_hockey",        L.NHL));
app.get("/scores/baseball",  serveBoard("baseball",          L.MLB));

app.get("/health",(_,res)=>res.json({ok:true}));

app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
