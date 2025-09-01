// server.js — v22 (DIAG): strict LIVE clamp + detailed diagnostics and reasons
// Order = Finals (≤15m) → Live (true live only) → Scheduled (soonest).
// New: /scoresdiag/:board and ?debug=1 add a "debug" block to help find why rows are missing/wrong.

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v22 (diag + strict LIVE clamp + reasons)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

// Polyfill for Node < 18
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ===== ENV =====
const V2_KEY = process.env.TSDB_V2_KEY || "";
const V1_KEY = process.env.TSDB_V1_KEY || "3";
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY missing (v2 live limited)");
if (!V1_KEY || V1_KEY === "3") console.warn("ℹ️ TSDB_V1_KEY missing; using shared test key");

// ===== CONST =====
const DEFAULT_COUNT = 10;
const FINAL_KEEP_MS = 15 * 60 * 1000;

const TTL = {
  LIVE:   15_000,
  NEXT:   5 * 60_000,
  SEASON: 3 * 60 * 60_000,
  DAY:    30 * 60_000,
  PAST:   10 * 60_000,
  OUT:    60_000,
};
const SWR_EXTRA = 5 * 60_000;

// Day scan throttle
const DAY_TOKENS_MAX = 80;
const DAY_TOKENS_REFILL_MS = 10_000;
let   DAY_TOKENS = DAY_TOKENS_MAX;
setInterval(() => { DAY_TOKENS = Math.min(DAY_TOKENS_MAX, DAY_TOKENS + 4); }, DAY_TOKENS_REFILL_MS);

// TheSportsDB league IDs
const L = { NBA:4387, NFL:4391, NHL:4380, MLB:4424 };

// v1 "sport" labels
const SPORT_LABEL = {
  basketball:"Basketball",
  american_football:"American Football",
  ice_hockey:"Ice Hockey",
  baseball:"Baseball",
};

// plausible max durations (filter bogus live)
const SPORT_MAX_MS = {
  basketball:        3 * 60 * 60 * 1000,
  american_football: 4 * 60 * 60 * 1000,
  ice_hockey:        3 * 60 * 60 * 1000,
  baseball:          5 * 60 * 60 * 1000,
};

// ===== SWR / RETRY =====
const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
const cache = new Map();
const inflight = new Map();
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
  const fetcher = async()=>{ const j = await fetchJsonRetry(url, extra); if (j) setCache(key,j,ttl); return j || c.val || null; };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ===== TIME / STATUS =====
function nowUTC(){ return new Date(); }
function cleanTime(t){ if(!t) return "00:00:00"; const s=String(t).trim(); return (/^tba$|^tbd$/i.test(s))?"00:00:00":s; }
function toMillis(d,t){ if(!d) return NaN; const tt=cleanTime(t); const hasTZ=/[zZ]$|[+\-]\d\d:?\d\d$/.test(tt); const ms=Date.parse(`${d}T${tt}${hasTZ?"":"Z"}`); return Number.isNaN(ms)?NaN:ms; }
function eventMillis(m){
  if (m.strTimestampMS){ const n=+m.strTimestampMS; if (!Number.isNaN(n)) return n; }
  if (m.strTimestamp){   const n=+m.strTimestamp*1000; if (!Number.isNaN(n)) return n; }
  let ms = toMillis(m.dateEvent, m.strTime); if (!Number.isNaN(ms)) return ms;
  ms = toMillis(m.dateEventLocal||m.dateEvent, m.strTimeLocal||m.strTime); if (!Number.isNaN(ms)) return ms;
  if (m.dateEvent){      ms=toMillis(m.dateEvent,"00:00:00Z"); if (!Number.isNaN(ms)) return ms; }
  if (m.dateEventLocal){ ms=toMillis(m.dateEventLocal,"00:00:00Z"); if (!Number.isNaN(ms)) return ms; }
  return NaN;
}
function pickScore(v){ return (v===undefined||v===null||v===""||v==="N/A") ? null : Number(v); }
function isFinalWord(s=""){ s=(s+"").toLowerCase(); return s.includes("final")||s==="ft"||s.includes("full time"); }
function isRecentFinal(m){
  const raw = m.strStatus || m.strProgress || "";
  if (!isFinalWord(raw)) return false;
  const ms = eventMillis(m); if (!isFinite(ms)) return false;
  return (Date.now() - ms) <= FINAL_KEEP_MS;
}
function hasStrongInGameToken(raw=""){
  const t = raw.toLowerCase();
  return /q\d|quarter|period|inning|half|ht|ot|overtime|^top\b|^bottom\b/.test(t);
}

const LIVE_MIN_ELAPSED_MS  = 5 * 60 * 1000;  // live if tokens + (score or ≥5m elapsed)
const START_EARLY_GRACE_MS = 90 * 1000;      // show scheduled for the first 90s around kickoff

function strongStatus(m, sport){
  const now = Date.now();
  const raw = String(m.strStatus || m.strProgress || "").trim();
  const s1  = pickScore(m.intHomeScore ?? m.intHomeGoals);
  const s2  = pickScore(m.intAwayScore ?? m.intAwayGoals);
  const scored = Number.isFinite(s1) && Number.isFinite(s2) && (s1 + s2 > 0);
  const ms  = eventMillis(m);
  const max = SPORT_MAX_MS[sport] || (3 * 60 * 60 * 1000);

  if (isFinalWord(raw)) return "Final";

  // STRICT FUTURE CLAMP: any future time -> Scheduled, regardless of v2
  if (isFinite(ms) && now + 1_000 < ms) return "Scheduled";

  if (isFinite(ms)){
    if (now < ms + START_EARLY_GRACE_MS) return "Scheduled";
    const elapsed = now - ms;
    if (m.__src === "live") {
      if (elapsed >= -START_EARLY_GRACE_MS && elapsed <= max) return "LIVE";
    } else {
      if ((hasStrongInGameToken(raw) && (scored || elapsed >= LIVE_MIN_ELAPSED_MS)) && elapsed >= 0 && elapsed <= max){
        return "LIVE";
      }
    }
    return "Scheduled";
  }

  if (m.__src === "live" && (hasStrongInGameToken(raw) || scored)) return "LIVE";
  return "Scheduled";
}

function matchKey(m){ return m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`; }
function pushUnique(arr,m){ const k=matchKey(m); if(!arr.some(x=>matchKey(x)===k)) arr.push(m); }

function sortForDisplay(a,b,sport){
  const ra = strongStatus(a, sport), rb = strongStatus(b, sport);
  const rank = s => s==="Final"?0 : s==="LIVE"?1 : 2;
  if (rank(ra) !== rank(rb)) return rank(ra) - rank(rb);
  const ta = eventMillis(a), tb = eventMillis(b);
  const aBad = !isFinite(ta), bBad = !isFinite(tb);
  if (aBad && !bBad) return +1;
  if (!aBad && bBad) return -1;
  if (ra === "Final") return tb - ta;
  if (ra === "LIVE")  return ta - tb; // earliest start first ≈ most progressed
  return ta - tb;                     // scheduled soonest first
}

// ===== TSDB =====
const V1 = (p)=>`https://www.thesportsdb.com/api/v1/json/${V1_KEY}/${p}`;

async function v2Livescore(sport){
  const s = sport.replace(/_/g," ");
  const urls = [
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out=[];
  for (const u of urls){
    const j = await memoJson(u, TTL.LIVE, V2_KEY ? {"X-API-KEY":V2_KEY} : {});
    if (j?.livescore?.length){
      for (const m of j.livescore){ m.__src = "live"; out.push(m); }
    }
  }
  return out;
}
async function v1NextLeague(id){ const j=await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT);   return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(V1(`eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`), TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST);   return Array.isArray(j?.events)?j.events:[]; }
async function v1EventsDay(sport,ymd){
  const label = SPORT_LABEL[sport] || sport;
  const j=await memoJson(V1(`eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`), TTL.DAY);
  return Array.isArray(j?.events)?j.events:[];
}

// Seasons
function seasonCrossCandidates(){
  const d=nowUTC(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1;
  const start=(m>=7)?y:y-1;
  return [`${start}-${start+1}`, `${start+1}-${start+2}`, `${start-1}-${start}`];
}
function seasonSingleCandidates(){ const y=nowUTC().getUTCFullYear(); return [String(y), String(y+1), String(y-1)]; }

// ===== FILL HELPERS (with reasons for DIAG) =====
function diagWrap(){ return { reasons:[], add:r=>r&&diagWrap.reasons&&diagWrap.reasons.push(r) }; }

async function fillFromSeasons(out, leagueId, sport, seasons, n, D){
  const now = Date.now();
  for (const s of seasons){
    const rows = await v1Season(leagueId, s);
    const fut = (rows||[])
      .filter(m => String(m.idLeague||"") === String(leagueId))
      .filter(m => { const ms=eventMillis(m); if (!(isFinite(ms)&&ms>=now)) {D.add("season_filtered_past_or_bad"); return false;} return true; })
      .sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of fut){ if (out.length>=n) break; pushUnique(out,m); }
    if (out.length>=n) break;
  }
}
async function dayFill(out, sport, leagueId, n, D, maxDays=45){
  const need = n - out.length; if (need <= 0) return;
  const tokensNeeded = Math.min(DAY_TOKENS, Math.max(need*2, 10));
  if (tokensNeeded <= 0) { D.add("day_throttle_no_tokens"); return; }
  DAY_TOKENS -= tokensNeeded;

  const now = Date.now();
  const today = nowUTC(); let used = 0;
  outer: for (let d=0; d<maxDays; d++){
    if (used >= tokensNeeded) break;
    const ymd = new Date(today.getTime() + d*86400000).toISOString().slice(0,10);
    const rows = await v1EventsDay(sport, ymd); used++;
    const fut = (rows||[])
      .filter(m => String(m.idLeague||"") === String(leagueId))
      .filter(m => { const ms=eventMillis(m); if (!(isFinite(ms)&&ms>=now)) {D.add("day_filtered_past_or_bad"); return false;} return true; })
      .sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of fut){ if (out.length>=n) break outer; pushUnique(out,m); }
  }
}

// ===== BUILD BOARD (with DIAG) =====
async function buildBoard({ sport, leagueId, seasons, n, wantDiag }){
  const finals=[], live=[], sched=[];
  const D = diagWrap(); D.reasons = []; // collect reasons

  const now = Date.now();
  const past = await v1PastLeague(leagueId);
  for (const m of (past||[])){
    if (String(m.idLeague||"") !== String(leagueId)) continue;
    if (isRecentFinal(m)) pushUnique(finals, m);
  }
  finals.sort((a,b)=>eventMillis(b)-eventMillis(a));

  const ls = await v2Livescore(sport);
  for (const m of (ls||[])){
    if (String(m.idLeague||"") !== String(leagueId)) continue;
    if (!isRecentFinal(m)) pushUnique(live, m);
  }

  const next = (await v1NextLeague(leagueId)).sort((a,b)=>eventMillis(a)-eventMillis(b));
  if (!next.length) D.add("next_empty_or_429");
  for (const m of next){
    if (finals.length+live.length+sched.length >= n) break;
    const ms = eventMillis(m); if (!isFinite(ms) || ms < now) { D.add("next_filtered_past_or_bad"); continue; }
    pushUnique(sched, m);
  }

  if (seasons?.length){
    await fillFromSeasons(sched, leagueId, sport, seasons, n - (finals.length+live.length), D);
  }

  if (finals.length+live.length+sched.length < n){
    await dayFill(sched, sport, leagueId, n, D);
  }

  const merged = [...finals, ...live, ...sched]
    .sort((a,b)=>sortForDisplay(a,b,sport))
    .slice(0, n);

  const counts = {
    finals: finals.length,
    live:   live.length,
    sched:  sched.length,
    out:    merged.length,
  };

  console.log(`[${sport}:${leagueId}] F=${counts.finals} L=${counts.live} S=${counts.sched} -> out=${counts.out}`);

  if (!wantDiag) return { items: merged, counts };

  // build diag per row
  const diagRows = merged.map(m => ({
    id: m.idEvent || null,
    leagueId: m.idLeague || null,
    home: m.strHomeTeam || m.homeTeam || m.strHome || "",
    away: m.strAwayTeam || m.awayTeam || m.strAway || "",
    strStatus: m.strStatus || m.strProgress || "",
    __src: m.__src || "mixed",
    startISO: (()=>{
      const ms=eventMillis(m); return isFinite(ms)?new Date(ms).toISOString():null;
    })(),
    score: {
      h: pickScore(m.intHomeScore??m.intHomeGoals),
      a: pickScore(m.intAwayScore??m.intAwayGoals),
    },
    bucket: strongStatus(m, sport),
  }));

  return { items: merged, counts, reasons: D.reasons, diag: diagRows };
}

// ===== WRAPPER / FORMAT =====
async function getBoardCached(key, builder){
  const c=getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const data=await builder(); setCache(key,data,TTL.OUT); return data; };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}
function clampN(q){ const n=parseInt(q||DEFAULT_COUNT,10); return Math.max(5, Math.min(10, Number.isFinite(n)?n:DEFAULT_COUNT)); }
function formatMatch(m, sport){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"";
  const away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=pickScore(m.intHomeScore??m.intHomeGoals);
  const s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const status=strongStatus(m, sport);
  const ms=eventMillis(m);
  return {
    team1:home, team2:away,
    score1: Number.isFinite(s1)?String(s1):"N/A",
    score2: Number.isFinite(s2)?String(s2):"N/A",
    headline:`${home} vs ${away} - ${status}`,
    start:isFinite(ms)?new Date(ms).toISOString():null,
  };
}

// ===== ROUTES =====
async function serve(req,res,sport,leagueId,seasons){
  try{
    const n = clampN(req.query.n);
    const wantDiag = req.query.debug === "1";
    const key = `OUT:${sport}:${leagueId}:${n}:${wantDiag?1:0}`;
    const data = await getBoardCached(key, ()=>buildBoard({ sport, leagueId, seasons, n, wantDiag }));

    if (wantDiag){
      // return formatted items + debug block
      const body = {
        items: data.items.map(m=>formatMatch(m, sport)),
        counts: data.counts,
        reasons: data.reasons || [],
        diag: data.diag || [],
      };
      return res.json(body);
    }
    return res.json(data.items.map(m=>formatMatch(m, sport)));
  }catch(e){ console.error(`${sport} error:`, e); res.status(500).json({error:"internal"}); }
}

app.get("/scores/nba",       (req,res)=>serve(req,res,"basketball",        L.NBA, seasonCrossCandidates()));
app.get("/scores/nfl",       (req,res)=>serve(req,res,"american_football", L.NFL, seasonSingleCandidates()));
app.get("/scores/nhl",       (req,res)=>serve(req,res,"ice_hockey",        L.NHL, seasonCrossCandidates()));
app.get("/scores/baseball",  (req,res)=>serve(req,res,"baseball",          L.MLB, seasonSingleCandidates()));

// DIAG aliases that always include debug
app.get("/scoresdiag/nba",      (req,res)=>{ req.query.debug="1"; serve(req,res,"basketball",        L.NBA, seasonCrossCandidates()); });
app.get("/scoresdiag/nfl",      (req,res)=>{ req.query.debug="1"; serve(req,res,"american_football", L.NFL, seasonSingleCandidates()); });
app.get("/scoresdiag/nhl",      (req,res)=>{ req.query.debug="1"; serve(req,res,"ice_hockey",        L.NHL, seasonCrossCandidates()); });
app.get("/scoresdiag/baseball", (req,res)=>{ req.query.debug="1"; serve(req,res,"baseball",          L.MLB, seasonSingleCandidates()); });

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
