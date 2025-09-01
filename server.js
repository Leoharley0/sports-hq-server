// server.js — v19: EPL season-window (accept date-only) + per-sport day tokens + SWR cache.
// Order: Finals(≤15m) → Live → Scheduled (soonest) — 10 rows each board.

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v19 (EPL season-window + date-only, per-sport tokens, SWR)";

// ---------- basic service ----------
app.get("/version", (_, res) => res.json({ build: BUILD }));
app.get("/health",  (_, res) => res.json({ ok: true }));

// Polyfill fetch (Node < 18)
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ---------- ENV ----------
const V2_KEY = process.env.TSDB_V2_KEY || ""; // livescore header
const V1_KEY = process.env.TSDB_V1_KEY || ""; // v1 path key; falls back to "3" if empty
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY not set (live may be limited)");
if (!V1_KEY) console.warn("ℹ️ TSDB_V1_KEY not set; using shared key '3'");

// ---------- CONFIG ----------
const DEFAULT_COUNT = 10;

const TTL = {
  LIVE:   15_000,
  NEXT:   5 * 60_000,
  SEASON: 6 * 60 * 60_000,
  DAY:    30 * 60_000,
  PAST:   10 * 60_000,
  OUT:    60_000,         // response SWR fresh window
};
const SWR_EXTRA = 5 * 60_000; // serve stale-while-revalidate for this many ms

// Per-sport day-scan token buckets (prevents soccer starvation at cold start)
const DAY_BUCKETS = {
  soccer:             { tokens: 40, max: 40, refill: 8 },   // every 10s
  american_football:  { tokens: 24, max: 24, refill: 4 },
  basketball:         { tokens: 24, max: 24, refill: 4 },
  ice_hockey:         { tokens: 24, max: 24, refill: 4 },
};
setInterval(() => {
  for (const b of Object.values(DAY_BUCKETS)) {
    b.tokens = Math.min(b.max, b.tokens + b.refill);
  }
}, 10_000);
function borrowDayTokens(sport, need) {
  const b = DAY_BUCKETS[sport] || DAY_BUCKETS.soccer;
  const take = Math.max(0, Math.min(b.tokens, need));
  b.tokens -= take;
  return take;
}

const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const jitter = ms => ms + Math.floor(Math.random() * (ms/3));

// ---------- SWR cache + inflight dedupe ----------
const cache = new Map();    // key -> {val, exp, swr}
const inflight = new Map(); // key -> Promise

function getCache(key){
  const e = cache.get(key); if (!e) return { hit:false };
  const now = Date.now();
  if (now <= e.exp) return { hit:true, fresh:true,  val:e.val };
  if (now <= e.swr) return { hit:true, fresh:false, val:e.val };
  return { hit:false };
}
function setCache(key, val, ttl){
  const now = Date.now();
  cache.set(key, { val, exp: now + ttl, swr: now + ttl + SWR_EXTRA });
}
async function withInflight(key, fn){
  if (inflight.has(key)) return inflight.get(key);
  const p = (async()=>{ try { return await fn(); } finally { inflight.delete(key); } })();
  inflight.set(key, p); return p;
}

// ---------- robust fetch ----------
async function fetchJsonRetry(url, extra={}, tries=4, baseDelay=650){
  let lastErr;
  for (let i=0; i<tries; i++){
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

  const fetcher = async () => {
    const j = await fetchJsonRetry(url, extra);
    if (j) setCache(key, j, ttl);
    return j || c.val || null;
  };
  if (c.hit && !c.fresh) { withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ---------- time / status ----------
function cleanTime(t){ if(!t) return "00:00:00"; const s=String(t).trim(); return (/^tba$|^tbd$/i.test(s))?"00:00:00":s; }
function toMillis(d,t){ if(!d) return NaN; const tt=cleanTime(t); const hasTZ=/[zZ]$|[+\-]\d\d:?\d\d$/.test(tt); const ms=Date.parse(`${d}T${tt}${hasTZ?"":"Z"}`); return Number.isNaN(ms)?NaN:ms; }
function eventMillis(m){
  let ms = toMillis(m.dateEvent, m.strTime); if (!Number.isNaN(ms)) return ms;
  ms = toMillis(m.dateEventLocal||m.dateEvent, m.strTimeLocal||m.strTime); if (!Number.isNaN(ms)) return ms;
  if (m.strTimestampMS) { const n=+m.strTimestampMS; if (!Number.isNaN(n)) return n; }
  if (m.strTimestamp)   { const n=+m.strTimestamp*1000; if (!Number.isNaN(n)) return n; }
  if (m.dateEvent)      { ms = toMillis(m.dateEvent, "00:00:00Z"); if (!Number.isNaN(ms)) return ms; }
  if (m.dateEventLocal) { ms = toMillis(m.dateEventLocal, "00:00:00Z"); if (!Number.isNaN(ms)) return ms; }
  return NaN;
}
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
const FINAL_KEEP_MS = 15*60*1000;
function isRecentFinal(m){
  const raw = m.strStatus || m.strProgress || "";
  if (!isFinalWord(raw)) return false;
  const ms = eventMillis(m); if (!isFinite(ms)) return false;
  return (Date.now() - ms) <= FINAL_KEEP_MS;
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

// Accept future fixtures even if time is TBA (synthesize 12:00Z) and clamp to horizon
function futureOK(m, now, maxDays){
  let ms = eventMillis(m);
  if (!isFinite(ms)) {
    const d = m.dateEventLocal || m.dateEvent;
    if (d) ms = Date.parse(`${d}T12:00:00Z`);
  }
  if (!isFinite(ms)) return false;
  if (ms < now) return false;
  if (maxDays && ms > now + maxDays*86400000) return false;
  if (!m.strTime && !m.strTimeLocal && !m.strTimestamp && !m.strTimestampMS) m._syntheticTime = true;
  return true;
}

// ---------- TSDB wrappers ----------
const V1 = (p)=>`https://www.thesportsdb.com/api/v1/json/${V1_KEY || "3"}/${p}`;
async function v2Livescore(sport){
  const s=sport.replace(/_/g," ");
  const urls = [
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out=[]; for (const u of urls){
    const j = await memoJson(u, TTL.LIVE, V2_KEY ? {"X-API-KEY":V2_KEY} : {});
    if (j?.livescore?.length) out.push(...j.livescore);
  }
  return out;
}
async function v1NextLeague(id){ const j=await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(V1(`eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`), TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }
const SPORT_LABEL={ soccer:"Soccer", basketball:"Basketball", american_football:"American Football", ice_hockey:"Ice Hockey" };
async function v1EventsDay(sport, ymd){ const label=SPORT_LABEL[sport]||sport; const j=await memoJson(V1(`eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`), TTL.DAY); return Array.isArray(j?.events)?j.events:[]; }

// ---------- seasons ----------
function guessSeasonCrossYear(){ const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1; const start=(m>=7)?y:y-1; return `${start}-${start+1}`; }
function nextCross(s){ const a=parseInt(s.split("-")[0],10); return `${a+1}-${a+2}`; }
function prevCross(s){ const a=parseInt(s.split("-")[0],10); return `${a-1}-${a}`; }
function seasonsCrossTriple(){ const c=guessSeasonCrossYear(); return [c, nextCross(c), prevCross(c)]; }
function seasonsNFL(){ const y=(new Date()).getUTCFullYear(); const c=guessSeasonCrossYear(); return [String(y), String(y+1), c, prevCross(c)]; }

// ---------- Leagues ----------
const L = {
  EPL: 4328,
  NBA: 4387,
  NFL: 4391,
  NHL: 4380,
};

// ---------- formatting ----------
function formatMatch(m){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"";
  const away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=pickScore(m.intHomeScore??m.intHomeGoals);
  const s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const status=normalizeStatus(m,s1,s2);
  const ms=eventMillis(m) || (m.dateEvent && Date.parse(`${m.dateEvent}T12:00:00Z`)) || null;
  return {
    team1:home, team2:away,
    score1: s1===null ? "N/A" : String(s1),
    score2: s2===null ? "N/A" : String(s2),
    headline: `${home} vs ${away} - ${status}`,
    start: isFinite(ms) ? new Date(ms).toISOString() : null
  };
}

// ---------- day fill (sport-aware) ----------
async function dayFill(sport, out, leagueId, n, horizonDays = 28) {
  let short = n - out.length; if (short <= 0) return { used:0, kept:0 };
  const now = Date.now();
  const today = new Date();
  let budget = borrowDayTokens(sport, short * 2);
  let used=0, kept=0;

  for (let d=0; d<horizonDays && out.length<n && budget>0; d++){
    budget--; used++;
    const ymd = new Date(today.getTime() + d*86400000).toISOString().slice(0,10);
    const rows = await v1EventsDay(sport, ymd);
    for (const m of rows || []){
      if (String(m.idLeague||"") !== String(leagueId)) continue;
      if (!futureOK(m, now, horizonDays)) continue;
      pushUnique(out, m); kept++;
      if (out.length >= n) break;
    }
  }
  return { used, kept };
}

// ---------- builders ----------
const EPL_HORIZON_DAYS = 35;

async function buildSoccerEPL(n){
  const finals=[], live=[], sched=[];
  const now = Date.now();

  // finals (≤15m)
  const past = await v1PastLeague(L.EPL);
  for (const m of past||[]) if (isRecentFinal(m)) pushUnique(finals, m);
  finals.sort((a,b)=>eventMillis(b)-eventMillis(a));

  // live
  const ls = await v2Livescore("soccer");
  for (const m of ls||[]) if (String(m.idLeague||"")===String(L.EPL) && !isRecentFinal(m)) pushUnique(live, m);

  // scheduled from season (accept date-only within horizon)
  for (const s of seasonsCrossTriple()){
    const rows = await v1Season(L.EPL, s);
    for (const m of rows || []){
      if (futureOK(m, now, EPL_HORIZON_DAYS)) pushUnique(sched, m);
      if (finals.length + live.length + sched.length >= n) break;
    }
    if (finals.length + live.length + sched.length >= n) break;
  }

  // top-up with nextleague
  if (finals.length + live.length + sched.length < n){
    const next = (await v1NextLeague(L.EPL)).sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of next){
      if (futureOK(m, now, EPL_HORIZON_DAYS)) pushUnique(sched, m);
      if (finals.length + live.length + sched.length >= n) break;
    }
  }

  // last resort: day scan
  if (finals.length + live.length + sched.length < n){
    await dayFill("soccer", sched, L.EPL, n - (finals.length + live.length), EPL_HORIZON_DAYS);
  }

  const out = [...finals, ...live, ...sched].sort(sortForDisplay).slice(0, n);
  console.log(`[soccer:EPL] F=${finals.length} L=${live.length} S=${sched.length} -> out=${out.length}`);
  return out;
}

async function buildSingle({ sport, leagueId, seasons, n, horizonDays = 90 }){
  const finals=[], live=[], sched=[];
  const now = Date.now();

  const past = await v1PastLeague(leagueId);
  for (const m of past||[]) if (isRecentFinal(m)) pushUnique(finals, m);
  finals.sort((a,b)=>eventMillis(b)-eventMillis(a));

  const ls = await v2Livescore(sport);
  for (const m of ls||[]) if (String(m.idLeague||"")===String(leagueId) && !isRecentFinal(m)) pushUnique(live, m);

  for (const s of seasons){
    const rows = await v1Season(leagueId, s);
    for (const m of rows || []){
      if (futureOK(m, now, horizonDays)) pushUnique(sched, m);
      if (finals.length + live.length + sched.length >= n) break;
    }
    if (finals.length + live.length + sched.length >= n) break;
  }

  if (finals.length + live.length + sched.length < n){
    const next = (await v1NextLeague(leagueId)).sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of next){
      if (futureOK(m, now, horizonDays)) pushUnique(sched, m);
      if (finals.length + live.length + sched.length >= n) break;
    }
  }

  if (finals.length + live.length + sched.length < n){
    await dayFill(sport, sched, leagueId, n - (finals.length + live.length), 21);
  }

  const out = [...finals, ...live, ...sched].sort(sortForDisplay).slice(0, n);
  console.log(`[${sport}:${leagueId}] F=${finals.length} L=${live.length} S=${sched.length} -> out=${out.length}`);
  return out;
}

// ---------- cached wrapper ----------
async function getBoardCached(key, builder, nocache){
  if (nocache){
    const data = await builder();
    setCache(key, data, TTL.OUT);
    return data;
  }
  const c = getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher = async()=>{ const data=await builder(); setCache(key,data,TTL.OUT); return data; };
  if (c.hit && !c.fresh) { withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ---------- routes ----------
app.get("/scores/soccer", async (req,res)=>{
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT, 10) || DEFAULT_COUNT));
    const nocache = String(req.query.nocache||"") === "1";
    const items = await getBoardCached(`OUT:soccerEPL:${n}`, ()=>buildSoccerEPL(n), nocache);
    res.json(items.map(formatMatch));
  }catch(e){ console.error("soccer error:", e); res.status(500).json({error:"internal"}); }
});

app.get("/scores/nba", async (req,res)=>serveSingle(req,res,"basketball",        L.NBA, seasonsCrossTriple()));
app.get("/scores/nfl", async (req,res)=>serveSingle(req,res,"american_football", L.NFL, seasonsNFL()));
app.get("/scores/nhl", async (req,res)=>serveSingle(req,res,"ice_hockey",        L.NHL, seasonsCrossTriple()));

async function serveSingle(req,res,sport,leagueId,seasons){
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT, 10) || DEFAULT_COUNT));
    const nocache = String(req.query.nocache||"") === "1";
    const items = await getBoardCached(`OUT:${sport}:${leagueId}:${n}`, () =>
      buildSingle({ sport, leagueId, seasons, n }), nocache
    );
    res.json(items.map(formatMatch));
  }catch(e){ console.error(`${sport} error:`, e); res.status(500).json({error:"internal"}); }
}

// Optional: prewarm soccer so cache is ready
(async function prewarm(){
  try { await getBoardCached(`OUT:soccerEPL:10`, ()=>buildSoccerEPL(10), true); }
  catch(e){ console.warn("[prewarm] soccer failed:", e?.message); }
})();

app.listen(PORT, () => console.log(`Server listening on ${PORT} — ${BUILD}`));
