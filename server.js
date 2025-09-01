// server.js — v20.2 (NBA/NFL/NHL/MLB) — finals ≤15m → live → scheduled,
// strict LIVE gating (progress/score/elapsed), SWR caching, low-load day fill.

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v20.2 (NBA/NFL/NHL/MLB · strict LIVE · SWR · ≤10 rows)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

// Polyfill for Node < 18
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ===== ENV =====
const V2_KEY = process.env.TSDB_V2_KEY || "";           // v2 livescore header
const V1_KEY = process.env.TSDB_V1_KEY || "3";          // v1 path key (falls back to public "3" safely)
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY missing (live may be limited)");
if (!V1_KEY || V1_KEY === "3") console.warn("ℹ️ TSDB_V1_KEY missing; using shared/test key");

// ===== CONSTANTS =====
const DEFAULT_COUNT = 10;   // rows per board (max 10)
const FINAL_KEEP_MS  = 15 * 60 * 1000;   // keep recent Finals for 15 minutes

// Cache TTLs
const TTL = {
  LIVE:   15_000,
  NEXT:   5 * 60_000,
  SEASON: 3 * 60 * 60_000,
  DAY:    30 * 60_000,
  PAST:   10 * 60_000,
  OUT:    60_000,
};
const SWR_EXTRA = 5 * 60_000;

// Day-scan throttling (prevents 429 storms)
const DAY_TOKENS_MAX = 80;
const DAY_TOKENS_REFILL_MS = 10_000;
let   DAY_TOKENS = DAY_TOKENS_MAX;
setInterval(() => { DAY_TOKENS = Math.min(DAY_TOKENS_MAX, DAY_TOKENS + 4); }, DAY_TOKENS_REFILL_MS);

// IDs (TheSportsDB)
const L = {
  NBA: 4387,
  NFL: 4391,
  NHL: 4380,
  MLB: 4424, // Major League Baseball
};

// v1 “sport” label for eventsday.php
const SPORT_LABEL = {
  basketball:        "Basketball",
  american_football: "American Football",
  ice_hockey:        "Ice Hockey",
  baseball:          "Baseball",
};

// ===== SWR CACHE / RETRY =====
const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
const cache = new Map();    // key -> {val, exp, swr}
const inflight = new Map(); // key -> Promise
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = ms => ms + Math.floor(Math.random() * (ms/3));

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
  const p = (async()=>{ try { return await fn(); } finally { inflight.delete(key); } })();
  inflight.set(key, p);
  return p;
}

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

  const fetcher = async()=>{
    const j = await fetchJsonRetry(url, extra);
    if (j) setCache(key, j, ttl);
    return j || c.val || null;
  };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ===== TIME / STATUS HELPERS =====
function cleanTime(t){ if(!t) return "00:00:00"; const s=String(t).trim(); return (/^tba$|^tbd$/i.test(s))?"00:00:00":s; }
function toMillis(d,t){ if(!d) return NaN; const tt=cleanTime(t); const hasTZ=/[zZ]$|[+\-]\d\d:?\d\d$/.test(tt); const ms=Date.parse(`${d}T${tt}${hasTZ?"":"Z"}`); return Number.isNaN(ms)?NaN:ms; }
function eventMillis(m){
  let ms = toMillis(m.dateEvent, m.strTime); if (!Number.isNaN(ms)) return ms;
  ms = toMillis(m.dateEventLocal||m.dateEvent, m.strTimeLocal||m.strTime); if (!Number.isNaN(ms)) return ms;
  if (m.strTimestampMS){ const n=+m.strTimestampMS; if (!Number.isNaN(n)) return n; }
  if (m.strTimestamp){   const n=+m.strTimestamp*1000; if (!Number.isNaN(n)) return n; }
  if (m.dateEvent){      ms=toMillis(m.dateEvent,"00:00:00Z"); if (!Number.isNaN(ms)) return ms; }
  if (m.dateEventLocal){ ms=toMillis(m.dateEventLocal,"00:00:00Z"); if (!Number.isNaN(ms)) return ms; }
  return NaN;
}
function pickScore(v){ return (v===undefined||v===null||v===""||v==="N/A")?null:Number(v); }
function isFinalWord(s=""){ s=(s+"").toLowerCase(); return s.includes("final")||s==="ft"||s.includes("full time"); }
function isRecentFinal(m){
  const raw = m.strStatus || m.strProgress || "";
  if (!isFinalWord(raw)) return false;
  const ms = eventMillis(m); if (!isFinite(ms)) return false;
  return (Date.now() - ms) <= FINAL_KEEP_MS;
}

// Strict LIVE gating (prevents “Live” with N/A–N/A or just at kickoff)
const LIVE_MIN_ELAPSED_MS   = 5 * 60 * 1000;  // require 5m elapsed if no score/progress
const START_EARLY_GRACE_MS  = 90 * 1000;      // treat just-before-kickoff as Scheduled

function hasStrongInGameToken(raw = "", sport = "") {
  const t = raw.toLowerCase().trim();
  // appears only when actually underway (quarters/periods/innings/OT/halves etc.)
  return /q\d|quarter|period|inning|half|ht|ot|overtime|^1st\b|^2nd\b|^3rd\b|^4th\b|top\b|bottom\b/.test(t);
}
function strongStatus(m, sport){
  const now = Date.now();
  const raw = String(m.strStatus || m.strProgress || "").trim();
  const s1 = pickScore(m.intHomeScore ?? m.intHomeGoals);
  const s2 = pickScore(m.intAwayScore ?? m.intAwayGoals);
  const scored = Number.isFinite(s1) && Number.isFinite(s2) && (s1 + s2 > 0);
  const ms = eventMillis(m);
  if (isFinalWord(raw)) return "Final";
  if (isFinite(ms) && ms > now + START_EARLY_GRACE_MS) return "Scheduled";
  if (isFinite(ms) && now >= ms - START_EARLY_GRACE_MS){
    const elapsed = now - ms;
    if (scored || hasStrongInGameToken(raw, sport) || elapsed >= LIVE_MIN_ELAPSED_MS) return "LIVE";
    return "Scheduled";
  }
  if (hasStrongInGameToken(raw, sport) && scored) return "LIVE";
  return "Scheduled";
}

function matchKey(m){ return m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`; }
function pushUnique(arr,m){ const k=matchKey(m); if(!arr.some(x=>matchKey(x)===k)) arr.push(m); }

// Finals (newest first), Live (oldest start first ≈ soonest to finish), Scheduled (soonest)
function sortForDisplay(a,b, sport){
  const sa = strongStatus(a, sport);
  const sb = strongStatus(b, sport);
  const rank = s => s==="Final"?0 : s==="LIVE"?1 : 2;
  if (rank(sa) !== rank(sb)) return rank(sa) - rank(sb);

  const ta = eventMillis(a), tb = eventMillis(b);
  const aBad = !isFinite(ta), bBad = !isFinite(tb);
  if (aBad && !bBad) return +1;
  if (!aBad && bBad) return -1;

  if (sa === "Final") return tb - ta; // newest finals first
  if (sa === "LIVE")  return ta - tb; // earliest start (most progressed) first
  return ta - tb;                     // scheduled soonest first
}

// ===== TSDB WRAPPERS =====
const V1 = (p)=>`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/${p}`;

async function v2Livescore(sport){
  const s = sport.replace(/_/g, " ");
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
async function v1NextLeague(id){
  const j = await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT);
  return Array.isArray(j?.events) ? j.events : [];
}
async function v1Season(id, s){
  const j = await memoJson(V1(`eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`), TTL.SEASON);
  return Array.isArray(j?.events) ? j.events : [];
}
async function v1PastLeague(id){
  const j = await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST);
  return Array.isArray(j?.events) ? j.events : [];
}
async function v1EventsDay(sport, ymd){
  const label = SPORT_LABEL[sport] || sport;
  const j = await memoJson(V1(`eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`), TTL.DAY);
  return Array.isArray(j?.events) ? j.events : [];
}

// Seasons (cross-year for NBA/NHL; single-year for NFL/MLB)
function nowUTC(){ return new Date(); }
function seasonCrossCandidates(){
  const d=nowUTC(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1;
  const start = (m>=7)?y:y-1;
  return [`${start}-${start+1}`, `${start+1}-${start+2}`, `${start-1}-${start}`];
}
function seasonSingleCandidates(){ const y=nowUTC().getUTCFullYear(); return [String(y), String(y+1), String(y-1)]; }

// ===== FILL HELPERS =====
async function fillFromSeasons(out, leagueId, sport, seasons, n){
  const now = Date.now();
  for (const s of seasons){
    const rows = await v1Season(leagueId, s);
    const fut = (rows||[])
      .filter(m => String(m.idLeague||"") === String(leagueId))
      .filter(m => { const ms=eventMillis(m); return isFinite(ms) && ms>=now; })
      .sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of fut){ if (out.length>=n) break; pushUnique(out, m); }
    if (out.length>=n) break;
  }
}

async function dayFill(out, sport, leagueId, n, maxDays=30){
  const need = n - out.length;
  if (need <= 0) return;

  const tokensNeeded = Math.min(DAY_TOKENS, Math.max(need * 2, 10));
  if (tokensNeeded <= 0) { console.warn(`[DAY throttle] ${sport}/${leagueId} short, tokens=0`); return; }
  DAY_TOKENS -= tokensNeeded;

  const now = Date.now();
  const today = nowUTC();
  let used = 0;

  outer: for (let d=0; d<maxDays; d++){
    if (used >= tokensNeeded) break;
    const ymd = new Date(today.getTime() + d*86400000).toISOString().slice(0,10);
    const rows = await v1EventsDay(sport, ymd); used++;
    const fut = (rows||[])
      .filter(m => String(m.idLeague||"") === String(leagueId))
      .filter(m => { const ms=eventMillis(m); return isFinite(ms) && ms>=now; })
      .sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of fut){
      if (out.length>=n) break outer;
      pushUnique(out, m);
    }
  }
}

// ===== BOARD BUILDER =====
async function buildBoard({ sport, leagueId, seasons, n }){
  const finals = [], live = [], sched = [];
  const now = Date.now();

  // 1) recent finals (≤15m)
  const past = await v1PastLeague(leagueId);
  for (const m of (past||[])){
    if (String(m.idLeague||"") !== String(leagueId)) continue;
    if (isRecentFinal(m)) pushUnique(finals, m);
  }
  finals.sort((a,b)=>eventMillis(b)-eventMillis(a));

  // 2) live
  const ls = await v2Livescore(sport);
  for (const m of (ls||[])){
    if (String(m.idLeague||"") !== String(leagueId)) continue;
    if (!isRecentFinal(m)) pushUnique(live, m);
  }

  // 3) scheduled (cheap “next league”)
  const next = (await v1NextLeague(leagueId)).sort((a,b)=>eventMillis(a)-eventMillis(b));
  for (const m of next){
    if (finals.length+live.length+sched.length >= n) break;
    const ms = eventMillis(m); if (!isFinite(ms) || ms < now) continue;
    pushUnique(sched, m);
  }

  // 4) seasons (future only)
  if (seasons?.length){
    await fillFromSeasons(sched, leagueId, sport, seasons, n - (finals.length+live.length));
  }

  // 5) day scan fallback (tokened)
  if (finals.length+live.length+sched.length < n){
    await dayFill(sched, sport, leagueId, n);
  }

  const merged = [...finals, ...live, ...sched].sort((a,b)=>sortForDisplay(a,b,sport)).slice(0, n);
  return merged;
}

// ===== CACHED WRAPPER =====
async function getBoardCached(key, builder){
  const c = getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher = async()=>{ const data = await builder(); setCache(key, data, TTL.OUT); return data; };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ===== FORMATTER =====
function formatMatch(m, sport){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"";
  const away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=pickScore(m.intHomeScore??m.intHomeGoals);
  const s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const status = strongStatus(m, sport);
  const ms=eventMillis(m);
  return {
    team1: home, team2: away,
    score1: Number.isFinite(s1) ? String(s1) : "N/A",
    score2: Number.isFinite(s2) ? String(s2) : "N/A",
    headline: `${home} vs ${away} - ${status}`,
    start: isFinite(ms) ? new Date(ms).toISOString() : null,
  };
}

// ===== ROUTES =====
function clampN(q){
  const n = parseInt(q || DEFAULT_COUNT, 10);
  return Math.max(5, Math.min(10, Number.isFinite(n) ? n : DEFAULT_COUNT));
}

app.get("/scores/nba", async (req,res)=>{
  try{
    const n = clampN(req.query.n);
    const key = `OUT:nba:${n}`;
    const items = await getBoardCached(key, () =>
      buildBoard({ sport:"basketball", leagueId:L.NBA, seasons:seasonCrossCandidates(), n })
    );
    res.json(items.map(m=>formatMatch(m, "basketball")));
  }catch(e){ console.error("nba error:", e); res.status(500).json({error:"internal"}); }
});

app.get("/scores/nfl", async (req,res)=>{
  try{
    const n = clampN(req.query.n);
    const key = `OUT:nfl:${n}`;
    const items = await getBoardCached(key, () =>
      buildBoard({ sport:"american_football", leagueId:L.NFL, seasons:seasonSingleCandidates(), n })
    );
    res.json(items.map(m=>formatMatch(m, "american_football")));
  }catch(e){ console.error("nfl error:", e); res.status(500).json({error:"internal"}); }
});

app.get("/scores/nhl", async (req,res)=>{
  try{
    const n = clampN(req.query.n);
    const key = `OUT:nhl:${n}`;
    const items = await getBoardCached(key, () =>
      buildBoard({ sport:"ice_hockey", leagueId:L.NHL, seasons:seasonCrossCandidates(), n })
    );
    res.json(items.map(m=>formatMatch(m, "ice_hockey")));
  }catch(e){ console.error("nhl error:", e); res.status(500).json({error:"internal"}); }
});

app.get("/scores/baseball", async (req,res)=>{
  try{
    const n = clampN(req.query.n);
    const key = `OUT:mlb:${n}`;
    const items = await getBoardCached(key, () =>
      buildBoard({ sport:"baseball", leagueId:L.MLB, seasons:seasonSingleCandidates(), n })
    );
    res.json(items.map(m=>formatMatch(m, "baseball")));
  }catch(e){ console.error("mlb error:", e); res.status(500).json({error:"internal"}); }
});

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
