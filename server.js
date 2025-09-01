// server.js — v24: EPL-only soccer, nocache switch, deep debug, gentle day-scan

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v24 (EPL-only + nocache + deep debug)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

// Polyfill fetch for Node < 18
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ========= ENV / CONFIG =========
const V2_KEY = process.env.TSDB_V2_KEY || ""; // v2 livescore header
const V1_KEY = process.env.TSDB_V1_KEY || ""; // v1 path key; falls back to shared "3" if blank
const V1 = (p) => `https://www.thesportsdb.com/api/v1/json/${V1_KEY || "3"}/${p}`;

const DEFAULT_COUNT = 10;
const TTL = {
  LIVE:   15_000,
  NEXT:    5 * 60_000,
  SEASON:  6 * 60 * 60_000,
  DAY:    30 * 60_000,
  PAST:   10 * 60_000,
  OUT:     1 * 60_000,
};
const SWR_EXTRA = 5 * 60_000;

const DAY_SCAN_MAX_DAYS = 45;     // safety upper bound
const DAY_SCAN_DEFAULT_DAYS = 30; // typical look-ahead for fallback
let DAY_TOKENS = 80;              // very gentle token bucket for day scans
setInterval(() => { DAY_TOKENS = Math.min(80, DAY_TOKENS + 4); }, 10_000);

const COMMON_HEADERS = {
  "User-Agent": "SportsHQ/1.0 (+render.com)",
  "Accept": "application/json"
};

// ========= Utilities =========
const sleep  = (ms)=> new Promise(r=>setTimeout(r, ms));
const jitter = (ms)=> ms + Math.floor(Math.random()*(ms/3));
function qBool(q) { if (!q) return false; const v=String(q).toLowerCase(); return v==="1"||v==="true"||v==="yes"; }

// SWR cache + inflight dedupe
const cache = new Map();    // key -> {val,exp,swr}
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
  cache.set(key, {val,exp:now+ttl,swr:now+ttl+SWR_EXTRA});
}
async function withInflight(key, fn){
  if (inflight.has(key)) return inflight.get(key);
  const p = (async()=>{ try{ return await fn(); } finally{ inflight.delete(key); } })();
  inflight.set(key,p); return p;
}

// robust fetch with 429 retry/backoff
async function fetchJsonRetry(url, extra={}, tries=4, baseDelay=650){
  let lastErr;
  for (let i=0;i<tries;i++){
    try{
      const res = await fetch(url, { headers: { ...COMMON_HEADERS, ...extra } });
      const txt = await res.text();
      if (res.status === 429) {
        const ra = Number(res.headers?.get("retry-after")) || 0;
        const wait = jitter(ra ? ra*1000 : baseDelay*Math.pow(2,i));
        console.warn(`[429] wait ${wait}ms :: ${url}`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} | ${txt.slice(0,200)}`);
      return JSON.parse(txt);
    } catch(e){
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

  const fetcher = async ()=>{
    const j = await fetchJsonRetry(url, extra);
    if (j) setCache(key, j, ttl);
    return j || c.val || null;
  };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ========= Time & status =========
function cleanTime(t){ if(!t) return "00:00:00"; const s=String(t).trim(); return (/^tba$|^tbd$/i.test(s))?"00:00:00":s; }
function toMillis(d,t){ if(!d) return NaN; const tt=cleanTime(t); const hasTZ=/[zZ]$|[+\-]\d\d:?\d\d$/.test(tt); const ms=Date.parse(`${d}T${tt}${hasTZ?"":"Z"}`); return Number.isNaN(ms)?NaN:ms; }
function eventMillis(m){
  let ms = toMillis(m.dateEvent, m.strTime); if (!Number.isNaN(ms)) return ms;
  ms = toMillis(m.dateEventLocal||m.dateEvent, m.strTimeLocal||m.strTime); if (!Number.isNaN(ms)) return ms;
  if (m.strTimestampMS){ const n=+m.strTimestampMS; if (!Number.isNaN(n)) return n; }
  if (m.strTimestamp){ const n=+m.strTimestamp*1000; if (!Number.isNaN(n)) return n; }
  if (m.dateEvent){ ms=toMillis(m.dateEvent,"00:00:00Z"); if (!Number.isNaN(ms)) return ms; }
  if (m.dateEventLocal){ ms=toMillis(m.dateEventLocal,"00:00:00Z"); if (!Number.isNaN(ms)) return ms; }
  return NaN;
}
function pickScore(v){ return (v===undefined||v===null||v===""||v==="N/A")?null:v; }
function isLiveWord(s=""){ s=(s+"").toLowerCase(); return s.includes("live")||s.includes("in play")||s.includes("half")||s==="ht"||s.includes("ot"); }
function isFinalWord(s=""){ s=(s+"").toLowerCase(); return s.includes("final")||s==="ft"||s.includes("full time"); }
function normalizeStatus(m,s1,s2){
  const raw=String(m.strStatus||m.strProgress||"").trim();
  const hasScore=(s1!==null)||(s2!==null);
  if (isFinalWord(raw)) return "Final";
  if (isLiveWord(raw))  return hasScore ? "LIVE" : "Scheduled";
  if (!raw||raw==="NS"||raw.toLowerCase()==="scheduled"||raw.toLowerCase()==="preview") return "Scheduled";
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
  const s1=pickScore(m.intHomeScore??m.intHomeGoals);
  const s2=pickScore(m.intAwayScore??m.intAwayGoals);
  return normalizeStatus(m,s1,s2);
}

// ========= Leagues & seasons =========
const L = {
  EPL: 4328,
  NBA: 4387,
  NFL: 4391,
  NHL: 4380,
};
function guessSeasonCrossYear(){
  const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1;
  const start=(m>=7)?y:y-1; return `${start}-${start+1}`;
}
function seasonsCrossTriple(){
  const c=guessSeasonCrossYear();
  const y0=parseInt(c.split("-")[0],10);
  return [`${y0}-${y0+1}`, `${y0+1}-${y0+2}`, `${y0-1}-${y0}`];
}
function seasonsNFL(){
  const y=(new Date()).getUTCFullYear();
  const c=guessSeasonCrossYear();
  const y0=parseInt(c.split("-")[0],10);
  return [String(y), String(y+1), `${y0}-${y0+1}`, `${y0-1}-${y0}`];
}

// ========= Helpers (unique/sort/format) =========
function matchKey(m){ return m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`; }
function pushUnique(arr,m){ const k=matchKey(m); if(!arr.some(x=>matchKey(x)===k)) arr.push(m); }
function sortForDisplay(a,b){
  const rank = s => s==="Final"?0 : s==="LIVE"?1 : 2;
  const sa=computedStatus(a), sb=computedStatus(b);
  const ra=rank(sa), rb=rank(sb);
  if (ra!==rb) return ra-rb;
  const ta=eventMillis(a), tb=eventMillis(b);
  const aBad=!isFinite(ta), bBad=!isFinite(tb);
  if (aBad && !bBad) return +1;
  if (!aBad && bBad) return -1;
  if (sa==="Final") return tb-ta; // newest finals first
  return ta-tb;                   // soonest for live/scheduled
}
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
const SPORT_LABEL={ soccer:"Soccer", basketball:"Basketball", american_football:"American Football", ice_hockey:"Ice Hockey" };

// ========= TSDB wrappers =========
async function v2Livescore(sport){
  const s=sport.replace(/_/g," ");
  const urls=[
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out=[];
  for (const u of urls){
    const j=await memoJson(u, TTL.LIVE, V2_KEY?{"X-API-KEY":V2_KEY}:{});
    if (j?.livescore?.length) out.push(...j.livescore);
  }
  return out;
}
async function v1PastLeague(id){ const j=await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST);  return Array.isArray(j?.events)?j.events:[]; }
async function v1NextLeague(id){ const j=await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(V1(`eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`), TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1EventsDay(sport, ymd){ const label=SPORT_LABEL[sport]||sport; const j=await memoJson(V1(`eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`), TTL.DAY); return Array.isArray(j?.events)?j.events:[]; }

// ========= Filters =========
const isEPL = (m)=> String(m.idLeague||"") === String(L.EPL);

// ========= Builders =========
async function fillFromSeasons(out, leagueId, seasons, n){
  const now=Date.now();
  for (const s of seasons){
    const rows = await v1Season(leagueId, s);
    const fut  = (rows||[])
      .filter(m => String(m.idLeague||"")===String(leagueId))
      .filter(m => { const ms=eventMillis(m); return isFinite(ms) && ms>=now; })
      .sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of fut){ if (out.length>=n) break; pushUnique(out, m); }
    if (out.length>=n) break;
  }
}

async function dayFillLeague(out, sport, leagueId, n, days=DAY_SCAN_DEFAULT_DAYS){
  if (out.length>=n) return;
  const want = n - out.length;
  const tokensWant = Math.max(6, want*2);
  if (DAY_TOKENS <= 0) { console.warn("[DAY throttle] no tokens"); return; }
  const take = Math.min(DAY_TOKENS, tokensWant);
  DAY_TOKENS -= take;

  const now=Date.now();
  const today = new Date();
  let used=0;
  outer: for (let d=0; d<Math.min(days, DAY_SCAN_MAX_DAYS); d++){
    if (used>=take) break;
    const ymd=new Date(today.getTime()+d*86400000).toISOString().slice(0,10);
    const rows=await v1EventsDay(sport, ymd); used++;
    const fut=(rows||[])
      .filter(m => String(m.idLeague||"")===String(leagueId))
      .filter(m => { const ms=eventMillis(m); return isFinite(ms) && ms>=now; })
      .sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of fut){ if (out.length>=n) break outer; pushUnique(out, m); }
  }
}

async function buildEPL(n){
  const finals=[], live=[], sched=[];
  const now=Date.now();

  // finals (recent only)
  const past = await v1PastLeague(L.EPL);
  for (const m of (past||[])) if (isRecentFinal(m)) pushUnique(finals, m);
  finals.sort((a,b)=>eventMillis(b)-eventMillis(a));

  // live (soccer feed filtered to EPL)
  const ls = await v2Livescore("soccer");
  for (const m of (ls||[])) if (isEPL(m) && !isRecentFinal(m)) pushUnique(live, m);

  // scheduled from season (cross-year set) first
  await fillFromSeasons(sched, L.EPL, seasonsCrossTriple(), n - (finals.length+live.length));

  // nextleague as a cheap top-up
  if (finals.length+live.length+sched.length < n){
    const next = (await v1NextLeague(L.EPL) || []).sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of next){
      if (finals.length+live.length+sched.length >= n) break;
      const ms=eventMillis(m); if (!isFinite(ms) || ms<now) continue;
      pushUnique(sched, m);
    }
  }

  // gentle day scan fallback if still short
  if (finals.length+live.length+sched.length < n){
    await dayFillLeague(sched, "soccer", L.EPL, n, DAY_SCAN_DEFAULT_DAYS);
  }

  const merged = [...finals, ...live, ...sched].sort(sortForDisplay).slice(0,n);
  console.log(`[soccer:EPL] F=${finals.length} L=${live.length} S=${sched.length} -> out=${merged.length}`);
  return merged;
}

async function buildSingle({ sport, leagueId, seasons, n }){
  const finals=[], live=[], sched=[];
  const now = Date.now();

  const past = await v1PastLeague(leagueId);
  for (const m of (past||[])) if (isRecentFinal(m)) pushUnique(finals, m);
  finals.sort((a,b)=>eventMillis(b)-eventMillis(a));

  const ls = await v2Livescore(sport);
  for (const m of (ls||[])) if (String(m.idLeague||"")===String(leagueId) && !isRecentFinal(m)) pushUnique(live, m);

  await fillFromSeasons(sched, leagueId, seasons, n - (finals.length+live.length));

  if (finals.length+live.length+sched.length < n){
    const next = (await v1NextLeague(leagueId) || []).sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of next){
      if (finals.length+live.length+sched.length >= n) break;
      const ms=eventMillis(m); if (!isFinite(ms)||ms<now) continue;
      pushUnique(sched, m);
    }
  }

  if (finals.length+live.length+sched.length < n){
    await dayFillLeague(sched, sport, leagueId, n, DAY_SCAN_DEFAULT_DAYS);
  }

  const merged = [...finals, ...live, ...sched].sort(sortForDisplay).slice(0,n);
  console.log(`[${sport}:${leagueId}] F=${finals.length} L=${live.length} S=${sched.length} -> out=${merged.length}`);
  return merged;
}

// ========= Cached wrapper =========
async function getBoardCached(key, builder){
  const c=getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher=async()=>{ const data=await builder(); setCache(key,data,TTL.OUT); return data; };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ========= Routes =========
app.get("/scores/soccer", async (req,res)=>{
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n||DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const noCache = qBool(req.query.nocache);
    const getData = () => buildEPL(n);
    const items = noCache ? await getData()
                          : await getBoardCached(`OUT:EPL:${n}`, getData);
    res.json(items.map(formatMatch));
  }catch(e){ console.error("soccer error:", e); res.status(500).json({error:"internal"}); }
});

async function serveSingle(req,res,sport,leagueId,seasons){
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n||DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const noCache = qBool(req.query.nocache);
    const getData = () => buildSingle({ sport, leagueId, seasons, n });
    const items = noCache ? await getData()
                          : await getBoardCached(`OUT:${sport}:${leagueId}:${n}`, getData);
    res.json(items.map(formatMatch));
  }catch(e){ console.error(`${sport} error:`, e); res.status(500).json({error:"internal"}); }
}
app.get("/scores/nba", async (req,res)=>serveSingle(req,res,"basketball",        L.NBA, seasonsCrossTriple()));
app.get("/scores/nfl", async (req,res)=>serveSingle(req,res,"american_football", L.NFL, seasonsNFL()));
app.get("/scores/nhl", async (req,res)=>serveSingle(req,res,"ice_hockey",        L.NHL, seasonsCrossTriple()));

// ========= Deep debug =========
app.get("/debug/epl", async (req, res) => {
  try {
    const now = Date.now();
    const out = { board: "EPL", leagueId: L.EPL, counts: {}, samples: {} };

    const past = await v1PastLeague(L.EPL);
    const finalsRecent = (past||[]).filter(isRecentFinal);
    out.counts.finals_raw = (past||[]).length;
    out.counts.finals_recent = finalsRecent.length;

    const live = await v2Livescore("soccer");
    const liveEpl = (live||[]).filter(isEPL);
    out.counts.live_raw = (live||[]).length;
    out.counts.live_epl = liveEpl.length;

    const next = await v1NextLeague(L.EPL);
    const nextFut = (next||[]).filter(m => isEPL(m) && isFinite(eventMillis(m)) && eventMillis(m) >= now);
    out.counts.next_raw = (next||[]).length;
    out.counts.next_fut = nextFut.length;

    const seasons = seasonsCrossTriple();
    out.counts.season = [];
    for (const s of seasons) {
      const rows = await v1Season(L.EPL, s);
      const fut  = (rows||[]).filter(isEPL).filter(m => { const ms = eventMillis(m); return isFinite(ms) && ms >= now; });
      out.counts.season.push({ season:s, raw:(rows||[]).length, fut:fut.length });
      if (!out.samples[`season_${s}`]) out.samples[`season_${s}`] = (rows||[]).slice(0,2);
    }

    const days = Math.max(7, Math.min(DAY_SCAN_MAX_DAYS, parseInt(req.query.days||String(DAY_SCAN_DEFAULT_DAYS), 10) || DAY_SCAN_DEFAULT_DAYS));
    out.counts.day = [];
    const today = new Date();
    for (let d=0; d<days; d++) {
      const ymd = new Date(today.getTime()+d*86400000).toISOString().slice(0,10);
      const rows = await v1EventsDay("soccer", ymd);
      const epl  = (rows||[]).filter(isEPL);
      out.counts.day.push({ ymd, raw:(rows||[]).length, epl:epl.length });
      if (d < 2) out.samples[`day_${ymd}`] = (rows||[]).slice(0,2);
    }

    res.json(out);
  } catch (e) {
    console.error("debug/epl error:", e);
    res.status(500).json({ error: "internal" });
  }
});

app.get("/debug/nfl", async (req, res) => {
  try {
    const now = Date.now();
    const out = { board: "NFL", leagueId: L.NFL, counts: {} };

    const past = await v1PastLeague(L.NFL);
    const finalsRecent = (past||[]).filter(isRecentFinal);
    out.counts.finals_raw = (past||[]).length;
    out.counts.finals_recent = finalsRecent.length;

    const live = await v2Livescore("american_football");
    const liveNfl = (live||[]).filter(m => String(m.idLeague||"")===String(L.NFL));
    out.counts.live_raw = (live||[]).length;
    out.counts.live_nfl = liveNfl.length;

    const next = await v1NextLeague(L.NFL);
    const nextFut = (next||[]).filter(m => String(m.idLeague||"")===String(L.NFL) && isFinite(eventMillis(m)) && eventMillis(m) >= now);
    out.counts.next_raw = (next||[]).length;
    out.counts.next_fut = nextFut.length;

    const seasons = seasonsNFL();
    out.counts.season = [];
    for (const s of seasons) {
      const rows = await v1Season(L.NFL, s);
      const fut  = (rows||[]).filter(m => String(m.idLeague||"")===String(L.NFL) && isFinite(eventMillis(m)) && eventMillis(m) >= now);
      out.counts.season.push({ season:s, raw:(rows||[]).length, fut:fut.length });
    }

    res.json(out);
  } catch (e) {
    console.error("debug/nfl error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// ========= Health =========
app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
