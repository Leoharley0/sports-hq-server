// server.js — v21: Soccer is EPL-only (no Big-4 / "any" fallback)
// Order = Finals (≤15m) → Live → Scheduled (soonest). Hard push to fill to 10
// with EPL-only sources: seasons, next-league, and EPL day-scan (tokened).

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v21 (soccer EPL-only, 10 rows target)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ===== ENV =====
const V2_KEY = process.env.TSDB_V2_KEY || "";
const V1_KEY = process.env.TSDB_V1_KEY || "";
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY missing (live may be limited)");
if (!V1_KEY) console.warn("ℹ️ TSDB_V1_KEY missing; using shared/test key");

// ===== CONFIG =====
const DEFAULT_COUNT = 10;                 // rows per board
const SOCCER_EPL_ONLY = true;            // enforced
const EPL_DAY_LOOKAHEAD_DAYS = 84;       // up to 12 weeks
const DAY_TOKENS_MAX = 80;               // shared budget for v1 day queries
const DAY_TOKENS_REFILL_MS = 10_000;
const SOCCER_MIN_TOKENS = 10;            // reserved floor so EPL can always fill

// Cache TTLs
const TTL = {
  LIVE:   15_000,
  NEXT:   5 * 60_000,
  SEASON: 6 * 60 * 60_000,
  DAY:    30 * 60_000,
  PAST:   10 * 60_000,
  OUT:    60_000,
};
const SWR_EXTRA = 5 * 60_000;

let DAY_TOKENS = DAY_TOKENS_MAX;
setInterval(() => { DAY_TOKENS = Math.min(DAY_TOKENS_MAX, DAY_TOKENS + 4); }, DAY_TOKENS_REFILL_MS);

const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const jitter = ms => ms + Math.floor(Math.random() * (ms/3));

// ===== SWR cache + in-flight =====
const cache = new Map(), inflight = new Map();
function getCache(key){
  const e = cache.get(key); if (!e) return {hit:false};
  const now = Date.now(); if (now <= e.exp) return {hit:true,fresh:true,val:e.val};
  if (now <= e.swr) return {hit:true,fresh:false,val:e.val};
  return {hit:false};
}
function setCache(key,val,ttl){ const now=Date.now(); cache.set(key,{val,exp:now+ttl,swr:now+ttl+SWR_EXTRA}); }
async function withInflight(key, fn){
  if (inflight.has(key)) return inflight.get(key);
  const p=(async()=>{ try{ return await fn(); } finally{ inflight.delete(key); } })();
  inflight.set(key,p); return p;
}

// ===== robust fetch (429-aware) =====
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
      lastErr = e; const wait=jitter(baseDelay*Math.pow(2,i));
      console.warn(`[retry] ${e.message}; wait ${wait}ms :: ${url}`); await sleep(wait);
    }
  }
  console.error(`[FAIL] ${lastErr?.message} :: ${url}`); return null;
}
async function memoJson(url, ttl, extra={}){
  const key = `URL:${url}`;
  const c = getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher = async()=>{ const j=await fetchJsonRetry(url, extra); if (j) setCache(key,j,ttl); return j || c.val || null; };
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
function isRecentFinal(m){ const raw=m.strStatus||m.strProgress||""; if(!isFinalWord(raw)) return false; const ms=eventMillis(m); if(!isFinite(ms)) return false; return (Date.now()-ms) <= FINAL_KEEP_MS; }
function computedStatus(m){ const s1=pickScore(m.intHomeScore??m.intHomeGoals), s2=pickScore(m.intAwayScore??m.intAwayGoals); return normalizeStatus(m,s1,s2); }
function matchKey(m){ return m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`; }
function pushUnique(arr,m){ const k=matchKey(m); if(!arr.some(x=>matchKey(x)===k)) arr.push(m); }
function sortForDisplay(a,b){
  const R = s => s==="Final"?0 : s==="LIVE"?1 : 2;
  const sa=computedStatus(a), sb=computedStatus(b);
  if (R(sa)!==R(sb)) return R(sa)-R(sb);
  const ta=eventMillis(a), tb=eventMillis(b);
  const aBad=!isFinite(ta), bBad=!isFinite(tb);
  if (aBad && !bBad) return +1;
  if (!aBad && bBad) return -1;
  if (sa==="Final") return tb-ta;
  return ta-tb;
}

// ===== TSDB =====
async function v2Livescore(sport){
  const s=sport.replace(/_/g," ");
  const urls=[
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out=[]; for (const u of urls){ const j=await memoJson(u, TTL.LIVE, V2_KEY?{"X-API-KEY":V2_KEY}:{});
    if (j?.livescore?.length) out.push(...j.livescore); }
  return out;
}
const V1 = (p)=>`https://www.thesportsdb.com/api/v1/json/${V1_KEY || "3"}/${p}`;
async function v1NextLeague(id){ const j=await memoJson(V1(`eventsnextleague.php?id=${id}`), TTL.NEXT); return Array.isArray(j?.events)?j.events:[]; }
async function v1Season(id,s){ const j=await memoJson(V1(`eventsseason.php?id=${id}&s=${encodeURIComponent(s)}`), TTL.SEASON); return Array.isArray(j?.events)?j.events:[]; }
async function v1PastLeague(id){ const j=await memoJson(V1(`eventspastleague.php?id=${id}`), TTL.PAST); return Array.isArray(j?.events)?j.events:[]; }
async function v1EventsDay(sport, ymd){
  const label = sport==="soccer" ? "Soccer" :
                sport==="basketball" ? "Basketball" :
                sport==="american_football" ? "American Football" :
                sport==="ice_hockey" ? "Ice Hockey" : sport;
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
const L = { EPL:4328, NBA:4387, NFL:4391, NHL:4380 };

// ===== format =====
function formatMatch(m){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"";
  const away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=pickScore(m.intHomeScore??m.intHomeGoals);
  const s2=pickScore(m.intAwayScore??m.intAwayGoals);
  const status=normalizeStatus(m,s1,s2); const ms=eventMillis(m);
  return { team1:home, team2:away, score1:s1===null?"N/A":String(s1), score2:s2===null?"N/A":String(s2),
           headline:`${home} vs ${away} - ${status}`, start:isFinite(ms)?new Date(ms).toISOString():null };
}

// ===== helpers (EPL-only day fill) =====
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

async function dayFillEPL(out, n){
  const need = n - out.length; if (need<=0) return 0;
  // Spend proportional to shortage, but keep a generous floor to break through 429s.
  const want   = Math.max(need * 6, 14);                 // stronger push when short
  const avail  = Math.max(SOCCER_MIN_TOKENS, DAY_TOKENS);
  const use    = Math.min(avail, want);
  if (use <= 0){ console.warn("[DAY throttle] EPL short, no tokens"); return 0; }

  const consume = Math.max(0, use - SOCCER_MIN_TOKENS);
  DAY_TOKENS -= consume;

  const today=new Date(); const now=Date.now();
  let used=0;

  outer: for (let d=0; d<EPL_DAY_LOOKAHEAD_DAYS; d++){
    if (used >= use) break;
    const ymd=new Date(today.getTime()+d*86400000).toISOString().slice(0,10);
    const rows=await v1EventsDay("soccer", ymd); used++;
    const fut=(rows||[])
      .filter(m => String(m.idLeague||"")===String(L.EPL))
      .filter(m => { const ms=eventMillis(m); return isFinite(ms) && ms>=now; })
      .sort((a,b)=>eventMillis(a)-eventMillis(b));
    for (const m of fut){ if (out.length>=n) break outer; pushUnique(out, m); }
  }
  return used;
}

// ===== builders =====
async function buildSoccerEPL(n){
  const finals=[], live=[], sched=[];
  // 1) recent finals (EPL)
  const past = await v1PastLeague(L.EPL);
  for (const m of (past||[])) if (isRecentFinal(m)) pushUnique(finals, m);
  finals.sort((a,b)=>eventMillis(b)-eventMillis(a));

  // 2) live (filter EPL)
  const ls = await v2Livescore("soccer");
  for (const m of (ls||[])) if (!isRecentFinal(m) && String(m.idLeague||"")===String(L.EPL)) pushUnique(live, m);

  // 3) scheduled: EPL seasons → EPL next → EPL day-scan
  await fillFromSeasons(sched, L.EPL, seasonsCrossTriple(), n - (finals.length+live.length));

  if ((finals.length+live.length+sched.length) < n){
    const next=(await v1NextLeague(L.EPL)).sort((a,b)=>eventMillis(a)-eventMillis(b));
    const now=Date.now();
    for (const m of next){
      if (finals.length+live.length+sched.length >= n) break;
      const ms=eventMillis(m); if (!isFinite(ms)||ms<now) continue; pushUnique(sched, m);
    }
  }

  let dayUsed = 0;
  if ((finals.length+live.length+sched.length) < n){
    dayUsed = await dayFillEPL(sched, n - (finals.length+live.length));
  }

  const out = [...finals, ...live, ...sched].sort(sortForDisplay).slice(0, n);
  console.log(`[soccer:EPL] finals=${finals.length} live=${live.length} sched=${sched.length} -> out=${out.length} (dayUsed=${dayUsed})`);
  return out;
}

async function buildSingle({ sport, leagueId, seasons, n }){
  const finals=[], live=[], sched=[];
  const past=await v1PastLeague(leagueId);
  for (const m of (past||[])) if (isRecentFinal(m)) pushUnique(finals,m);
  finals.sort((a,b)=>eventMillis(b)-eventMillis(a));

  const ls=await v2Livescore(sport);
  for (const m of (ls||[])) if (String(m.idLeague||"")===String(leagueId) && !isRecentFinal(m)) pushUnique(live,m);

  await fillFromSeasons(sched, leagueId, seasons, n - (finals.length+live.length));

  if ((finals.length+live.length+sched.length) < n){
    const next=(await v1NextLeague(leagueId)).sort((a,b)=>eventMillis(a)-eventMillis(b));
    const now=Date.now();
    for (const m of next){
      if (finals.length+live.length+sched.length >= n) break;
      const ms=eventMillis(m); if (!isFinite(ms)||ms<now) continue; pushUnique(sched, m);
    }
  }

  // Tokened day scan per single league
  const need = n - (finals.length+live.length+sched.length);
  if (need > 0){
    const want = Math.max(need * 4, 8);
    const use  = Math.min(DAY_TOKENS, want);
    if (use > 0){
      DAY_TOKENS -= use;
      const today=new Date(); const now=Date.now();
      let used=0;
      outer: for (let d=0; d<84; d++){
        if (used>=use) break;
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

  const out=[...finals,...live,...sched].sort(sortForDisplay).slice(0,n);
  console.log(`[${sport}] out=${out.length} (finals=${finals.length}, live=${live.length}, sched=${sched.length})`);
  return out;
}

// ===== cache wrapper (short TTL if short) =====
async function getBoardCached(key, builder){
  const c=getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher=async()=>{
    const data=await builder();
    const full=Array.isArray(data)&&data.length>=(DEFAULT_COUNT||10);
    setCache(key, data, full?TTL.OUT:8_000);
    return data;
  };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ===== routes =====
app.get("/scores/soccer", async (req,res)=>{
  try{
    const n=Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const items = await getBoardCached(`OUT:soccer_epl_only:${n}:${SOCCER_EPL_ONLY?1:0}`, () =>
      buildSoccerEPL(n)
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
    const n=Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const items=await getBoardCached(`OUT:${sport}:${leagueId}:${n}`, () =>
      buildSingle({ sport, leagueId, seasons, n })
    );
    console.log(`/scores/${sport} -> ${items.length} items (n=${n})`);
    res.json(items.map(formatMatch));
  }catch(e){ console.error(`${sport} error:`, e); res.status(500).json({error:"internal"}); }
}

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
