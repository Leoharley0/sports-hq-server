// server.js — v18: EPL-first (Big-4 fallback) with guaranteed 10 rows,
// short-TTL for short boards, and reserved day-scan tokens for soccer.

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v18 (soccer 10-rows guaranteed; short-TTL; token reserve)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

// Polyfill fetch for Node < 18
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ===== ENV KEYS =====
const V2_KEY = process.env.TSDB_V2_KEY || ""; // v2 livescore header
const V1_KEY = process.env.TSDB_V1_KEY || ""; // v1 path key (falls back to "3")
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY missing (live may be limited)");
if (!V1_KEY) console.warn("ℹ️ TSDB_V1_KEY missing; using shared/test key");

// ===== CONFIG =====
const DEFAULT_COUNT = 10;        // rows per board (client asks for 10)
const SOCCER_RELAX_FILL = true;  // if EPL < 10, top up with other Big-4

// Caches
const TTL = {
  LIVE:   15_000,          // live score feed
  NEXT:   5 * 60_000,      // next-league
  SEASON: 6 * 60 * 60_000, // season pages
  DAY:    30 * 60_000,     // day queries
  PAST:   10 * 60_000,     // recent past
  OUT:    60_000,          // final aggregated board
};
const SWR_EXTRA = 5 * 60_000;    // serve stale while revalidating

// Day-scan token bucket (limits v1 calls under 429 pressure)
const DAY_TOKENS_MAX   = 80;
const DAY_TOKENS_BURST = 20;
const DAY_TOKENS_REFILL_MS = 10_000;
let DAY_TOKENS = DAY_TOKENS_MAX;
// Reserve a tiny floor specifically so SOCCER can always top up.
const SOCCER_MIN_TOKENS = 6;

setInterval(() => { DAY_TOKENS = Math.min(DAY_TOKENS_MAX, DAY_TOKENS + 4); }, DAY_TOKENS_REFILL_MS);

const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const jitter = ms => ms + Math.floor(Math.random() * (ms/3));

// ===== SWR cache + in-flight dedupe =====
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
  cache.set(key, { val, exp: now + ttl, swr: now + ttl + SWR_EXTRA });
}
async function withInflight(key, fn){
  if (inflight.has(key)) return inflight.get(key);
  const p = (async()=>{ try{ return await fn(); } finally{ inflight.delete(key); } })();
  inflight.set(key,p); return p;
}

// ===== robust fetch with 429 backoff =====
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

  const fetcher = async ()=> {
    const j = await fetchJsonRetry(url, extra);
    if (j) setCache(key, j, ttl);
    return j || c.val || null;
  };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ===== time / status =====
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
  const raw=String(m.strStatus||m.strProgress||"").trim(), has=(s1!==null)||(s2!==null);
  if (isFinalWord(raw)) return "Final";
  if (isLiveWord(raw))  return has ? "LIVE" : "Scheduled";
  if (!raw||raw==="NS"||raw.toLowerCase()==="scheduled"||raw.toLowerCase()==="preview") return "Scheduled";
  return has ? raw : "Scheduled";
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
const SPORT_LABEL={ soccer:"Soccer", basketball:"Basketball", american_football:"American Football", ice_hockey:"Ice Hockey" };
async function v1EventsDay(sport, ymd){
  const label=SPORT_LABEL[sport]||sport;
  const j=await memoJson(V1(`eventsday.php?d=${ymd}&s=${encodeURIComponent(label)}`), TTL.DAY);
  return Array.isArray(j?.events)?j.events:[];
}

// ===== seasons =====
function guessSeasonCrossYear(){ const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1; const start=(m>=7)?y:y-1; return `${start}-${start+1}`; }
function nextCross(s){ const a=parseInt(s.split("-")[0],10); return `${a+1}-${a+2}`; }
function prevCross(s){ const a=parseInt(s.split("-")[0],10); return `${a-1}-${a}`; }
function seasonsCrossTriple(){ const c=guessSeasonCrossYear(); return [c, nextCross(c), prevCross(c)]; }
function seasonsNFL(){ const y=(new Date()).getUTCFullYear(); const c=guessSeasonCrossYear(); return [String(y), String(y+1), c, prevCross(c)]; }

// ===== leagues =====
const L = {
  EPL: 4328,
  BUNDESLIGA: 4331,
  LALIGA: 4335,
  LIGUE1: 4334,
  NBA: 4387,
  NFL: 4391,
  NHL: 4380,
};
const SOCCER_BIG4 = [L.EPL, L.BUNDESLIGA, L.LALIGA, L.LIGUE1];

// ===== formatting =====
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

// ===== helpers =====
async function fillFromSeasons(out, leagueId, seasons, n){
  const now=Date.now();
  for (const s of seasons){
    const rows=await v1Season(leagueId, s);
    const fut=(rows||[]).filter(m=>{const ms=eventMillis(m);return isFinite(ms)&&ms>=now;})
                        .sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of fut){ if (out.length>=n) break; pushUnique(out,m); }
    if (out.length>=n) break;
  }
}

// day-scan across a set of soccer leagues with token reserve
async function dayFillSoccer(leagues, out, n){
  const need = n - out.length;
  if (need <= 0) return;

  const want  = Math.max(2, need * 2); // proportional to need
  const avail = Math.max(SOCCER_MIN_TOKENS, DAY_TOKENS);
  const use   = Math.min(avail, Math.max(DAY_TOKENS_BURST, want));

  if (use <= 0) { console.warn("[DAY throttle] soccer short, no tokens"); return; }
  DAY_TOKENS -= Math.max(0, use - SOCCER_MIN_TOKENS);

  const now=Date.now();
  const today=new Date(); let used=0;
  outer: for (let d=0; d<28; d++){ // up to 4 weeks
    if (used >= use) break;
    const ymd=new Date(today.getTime()+d*86400000).toISOString().slice(0,10);
    const rows=await v1EventsDay("soccer", ymd); used++;
    const fut=(rows||[])
      .filter(m => leagues.includes(Number(m.idLeague||0)))
      .filter(m => { const ms=eventMillis(m); return isFinite(ms) && ms>=now; })
      .sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of fut){
      if (out.length>=n) break outer;
      pushUnique(out, m);
    }
  }
}

// ===== core builders =====
async function buildSoccerGuaranteed(n){
  const finals=[], live=[], sched=[];
  const now = Date.now();

  // 1) recent finals (EPL only)
  const past = await v1PastLeague(L.EPL);
  for (const m of (past||[])) if (isRecentFinal(m)) pushUnique(finals, m);
  finals.sort((a,b)=>eventMillis(b)-eventMillis(a));

  // 2) live (Big-4 only)
  const ls = await v2Livescore("soccer");
  for (const m of (ls||[])) if (!isRecentFinal(m) && SOCCER_BIG4.includes(Number(m.idLeague||0))) pushUnique(live, m);

  // 3) EPL seasons first (future)
  await fillFromSeasons(sched, L.EPL, seasonsCrossTriple(), n - (finals.length+live.length));

  // 4) cheap NEXT top-up (EPL then other Big-4 if relax)
  const nextLists = [];
  nextLists.push(await v1NextLeague(L.EPL));
  if (SOCCER_RELAX_FILL) for (const lg of SOCCER_BIG4) if (lg!==L.EPL) nextLists.push(await v1NextLeague(lg));
  for (const list of nextLists){
    const next=(list||[]).sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of next){
      if (finals.length+live.length+sched.length >= n) break;
      const ms=eventMillis(m); if (!isFinite(ms)||ms<now) continue;
      pushUnique(sched, m);
    }
    if (finals.length+live.length+sched.length >= n) break;
  }

  // 5) other Big-4 seasons (only if still short and relax on)
  if (SOCCER_RELAX_FILL && (finals.length+live.length+sched.length) < n){
    for (const lg of SOCCER_BIG4){
      if (lg === L.EPL) continue;
      await fillFromSeasons(sched, lg, seasonsCrossTriple(), n - (finals.length+live.length+sched.length));
      if (finals.length+live.length+sched.length >= n) break;
    }
  }

  // 6) day-scan fallback with token reserve
  if ((finals.length+live.length+sched.length) < n){
    await dayFillSoccer(SOCCER_RELAX_FILL ? SOCCER_BIG4 : [L.EPL], sched, n - (finals.length+live.length));
  }

  const merged = [...finals, ...live, ...sched].sort(sortForDisplay).slice(0, n);
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

  // cheap NEXT before day scans
  if ((finals.length+live.length+sched.length) < n){
    const next=(await v1NextLeague(leagueId)).sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of next){
      if (finals.length+live.length+sched.length >= n) break;
      const ms=eventMillis(m); if (!isFinite(ms)||ms<now) continue;
      pushUnique(sched, m);
    }
  }

  // light per-league day scan sharing the bucket
  let shortBy = n - (finals.length+live.length+sched.length);
  if (shortBy > 0){
    const want = Math.max(2, shortBy * 2);
    const use  = Math.min(DAY_TOKENS, Math.max(DAY_TOKENS_BURST, want));
    if (use > 0){
      DAY_TOKENS -= use;
      const today=new Date(); let used=0;
      outer: for (let d=0; d<28; d++){
        if (used >= use) break;
        const ymd=new Date(today.getTime()+d*86400000).toISOString().slice(0,10);
        const rows=await v1EventsDay(sport, ymd); used++;
        const fut=(rows||[])
          .filter(m => String(m.idLeague||"")===String(leagueId))
          .filter(m => { const ms=eventMillis(m); return isFinite(ms) && ms>=now; })
          .sort((a,b)=>eventMillis(a)-eventMillis(b));
        for (const m of fut){ if (finals.length+live.length+sched.length >= n) break outer; pushUnique(sched, m); }
      }
    } else {
      console.warn(`[DAY throttle] still short for ${sport} ${leagueId}`);
    }
  }

  return [...finals, ...live, ...sched].sort(sortForDisplay).slice(0, n);
}

// ===== cached wrappers (short-TTL for short results) =====
async function getBoardCached(key, builder){
  const c=getCache(key);
  if (c.hit && c.fresh) return c.val;

  const fetcher=async()=>{
    const data=await builder();
    const full = Array.isArray(data) && data.length >= (DEFAULT_COUNT || 10);
    setCache(key, data, full ? TTL.OUT : 10_000); // short cache if short list
    return data;
  };

  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ===== routes =====
app.get("/scores/soccer", async (req,res)=>{
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const items = await getBoardCached(`OUT:soccer_big4:${n}:${SOCCER_RELAX_FILL?1:0}`, () =>
      buildSoccerGuaranteed(n)
    );
    console.log(`/scores/soccer -> ${items.length} items (n=${n})`);
    res.json(items.map(formatMatch));
  }catch(e){ console.error("soccer error:", e); res.status(500).json({error:"internal"}); }
});

app.get("/scores/nba", async (req,res)=>serveSingle(req,res,"basketball",        L.NBA, seasonsCrossTriple()));
app.get("/scores/nfl", async (req,res)=>serveSingle(req,res,"american_football", L.NFL, seasonsNFL()));
app.get("/scores/nhl", async (req,res)=>serveSingle(req,res,"ice_hockey",        L.NHL, seasonsCrossTriple()));

async function serveSingle(req,res,sport,leagueId,seasons){
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const items = await getBoardCached(`OUT:${sport}:${leagueId}:${n}`, () =>
      buildSingle({ sport, leagueId, seasons, n })
    );
    console.log(`/scores/${sport} -> ${items.length} items (n=${n})`);
    res.json(items.map(formatMatch));
  }catch(e){ console.error(`${sport} error:`, e); res.status(500).json({error:"internal"}); }
}

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
