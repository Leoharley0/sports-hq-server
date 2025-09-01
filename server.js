// server.js — v18  (EPL-only guaranteed fill; other leagues unchanged)
// Order: Finals (<=15m) → Live → Scheduled (soonest). Low-load with SWR cache.

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

const BUILD = "SportsHQ v18 (soccer EPL guaranteed, others unchanged)";
app.get("/version", (_, res) => res.json({ build: BUILD }));

// Polyfill fetch for Node < 18
if (typeof fetch !== "function") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

// ===== ENV KEYS =====
const V2_KEY = process.env.TSDB_V2_KEY || "";   // v2 livescore header
const V1_KEY = process.env.TSDB_V1_KEY || "3";  // v1 path key (defaults to public "3")
if (!V2_KEY) console.warn("ℹ️ TSDB_V2_KEY missing (live may be limited)");
if (!V1_KEY || V1_KEY === "3") console.warn("ℹ️ TSDB_V1_KEY not set; using shared key");

// ===== CONSTANTS =====
const DEFAULT_COUNT = 10;

const TTL = {
  LIVE:   15_000,         // live feed
  NEXT:    5 * 60_000,    // next round
  SEASON:  6 * 60 * 60_000,
  DAY:     30 * 60_000,
  PAST:    10 * 60_000,
  OUT:     60_000,        // outbound payload
};
const SWR_EXTRA = 5 * 60_000; // serve-stale-while-revalidate window

// Light throttle bucket for day scans (shared by all boards)
const DAY_TOKENS_MAX = 80;
const DAY_TOKENS_REFILL_MS = 10_000;
let DAY_TOKENS = DAY_TOKENS_MAX;
setInterval(() => { DAY_TOKENS = Math.min(DAY_TOKENS_MAX, DAY_TOKENS + 4); }, DAY_TOKENS_REFILL_MS);

// ===== SWR CACHE + DEDUPE =====
const cache = new Map();    // key -> { val, exp, swr }
const inflight = new Map(); // key -> Promise

function getCache(key){
  const e = cache.get(key);
  if (!e) return { hit:false };
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

// ===== FETCH HELPERS =====
const COMMON_HEADERS = { "User-Agent":"SportsHQ/1.0 (+render.com)", "Accept":"application/json" };
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

  const fetcher = async ()=>{
    const j = await fetchJsonRetry(url, extra);
    if (j) setCache(key, j, ttl);
    return j || c.val || null;
  };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ===== TIME / STATUS UTILS =====
function isTBA(t){ if(!t) return true; const s=String(t).trim().toLowerCase(); return !s||s==="tba"||s==="tbd"||s==="ns"||s.startsWith("00:00:00"); }
function eventMillis(m){
  const combo=(d,t)=>{
    if (!d) return {ms:NaN, dateOnly:false, ymd:""};
    const ds=String(d).slice(0,10);
    if (isTBA(t)) return { ms: Date.parse(`${ds}T12:00:00Z`), dateOnly:true, ymd:ds };
    const tt=String(t).trim().replace(/([+\-]\d{2})(\d{2})$/,"$1:$2");
    const iso=/[Zz]|[+\-]\d{2}:\d{2}$/.test(tt)?`${d}T${tt}`:`${d}T${tt}Z`;
    const ms=Date.parse(iso); return {ms, dateOnly:false, ymd:ds};
  };
  let r=combo(m.dateEvent, m.strTime); if (Number.isFinite(r.ms)) return r;
  r=combo(m.dateEventLocal||m.dateEvent, m.strTimeLocal||m.strTime); if (Number.isFinite(r.ms)) return r;
  const tryNum = v => (v==null?NaN:(typeof v==="number"?v:(/^\d{13}$/.test(v)?+v:/^\d{10}$/.test(v)?+v*1000:NaN)));
  const ms = tryNum(m.strTimestampMS) || tryNum(m.strTimestamp);
  if (Number.isFinite(ms)) return {ms, dateOnly:false, ymd:new Date(ms).toISOString().slice(0,10)};
  return {ms:NaN, dateOnly:false, ymd:""};
}
function futureOK(ev, now){
  const {ms,dateOnly,ymd} = eventMillis(ev);
  if (Number.isFinite(ms) && ms >= now) return true;
  if (dateOnly){ const today=new Date(now).toISOString().slice(0,10); return ymd >= today; }
  return false;
}
function isLiveWord(s=""){ s=(s+"").toLowerCase(); return s.includes("live")||s.includes("in play")||s.includes("half")||s==="ht"||s.includes("ot")||/^q\d/.test(s)||s.includes("quarter"); }
function isFinalWord(s=""){ s=(s+"").toLowerCase(); return s.includes("final")||s==="ft"||s.includes("full time"); }
function statusOf(m){
  const raw=String(m.strStatus||m.strProgress||"").trim();
  const hasScore = (m.intHomeGoals!=null)||(m.intAwayGoals!=null)||(m.intHomeScore!=null)||(m.intAwayScore!=null);
  if (isFinalWord(raw)) return "Final";
  if (isLiveWord(raw))  return hasScore ? "LIVE" : "Scheduled";
  if (!raw||raw==="NS"||raw.toLowerCase()==="scheduled"||raw.toLowerCase()==="preview") return "Scheduled";
  return hasScore ? raw : "Scheduled";
}
function matchKey(m){ return m.idEvent || `${m.strHomeTeam}|${m.strAwayTeam}|${m.dateEvent||m.dateEventLocal||""}`; }
function pushUnique(arr,m){ const k=matchKey(m); if (!arr.some(x=>matchKey(x)===k)) arr.push(m); }
function sortForDisplay(a,b){
  const R=s=>s==="Final"?0:s==="LIVE"?1:2;
  const sa=statusOf(a), sb=statusOf(b);
  if (R(sa)!==R(sb)) return R(sa)-R(sb);
  const ta=eventMillis(a).ms, tb=eventMillis(b).ms;
  const aBad=!Number.isFinite(ta), bBad=!Number.isFinite(tb);
  if (aBad && !bBad) return +1;
  if (!aBad && bBad) return -1;
  if (sa==="Final") return tb-ta; // newest finals first
  return ta-tb;                   // soonest otherwise
}

// ===== TSDB WRAPPERS =====
async function v2Livescore(sport){
  const s=sport.replace(/_/g," ");
  const urls=[
    `https://www.thesportsdb.com/api/v2/json/livescore/${encodeURIComponent(s)}`,
    `https://www.thesportsdb.com/api/v2/json/livescore.php?s=${encodeURIComponent(s)}`
  ];
  const out=[]; const extra = V2_KEY ? {"X-API-KEY":V2_KEY} : {};
  for (const u of urls){ const j=await memoJson(u, TTL.LIVE, extra); if (j?.livescore?.length) out.push(...j.livescore); }
  return out;
}
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

// ===== SEASONS =====
function guessSeasonCrossYear(){ const d=new Date(), y=d.getUTCFullYear(), m=d.getUTCMonth()+1; const start=(m>=7)?y:y-1; return `${start}-${start+1}`; }
function seasonsCrossTriple(){ const c=guessSeasonCrossYear(); const prev=(a)=>`${+a.split("-")[0]-1}-${+a.split("-")[0]}`; const next=(a)=>`${+a.split("-")[0]+1}-${+a.split("-")[0]+2}`; return [c,next(c),prev(c)]; }
function seasonsNFL(){ const y=(new Date()).getUTCFullYear(); const c=guessSeasonCrossYear(); return [String(y), String(y+1), c, `${+c.split("-")[0]-1}-${c.split("-")[1]}`]; }

// ===== ID MAP =====
const L = { EPL:4328, NBA:4387, NFL:4391, NHL:4380 };

// ===== EPL-ONLY, GUARANTEED FILL =====
function sweepDates(weeks, dows){
  const out=new Set(); const now=new Date();
  const base=Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0,0,0);
  for (let w=0; w<weeks; w++){
    for (const dow of dows){
      const d = new Date(base + w*7*864e5);
      const delta = (dow - d.getUTCDay() + 7) % 7;
      out.add(new Date(base + (w*7+delta)*864e5).toISOString().slice(0,10));
    }
  }
  return Array.from(out).sort();
}

async function buildSoccerEPLGuaranteed(n){
  const now=Date.now();
  const finals=[], live=[], sched=[];
  const EPL_ID = L.EPL;

  // 1) recent finals (<=15m)
  const past = await v1PastLeague(EPL_ID);
  for (const m of (past||[])){
    const t=eventMillis(m).ms;
    if (isFinalWord(m.strStatus||m.strProgress||"") && Number.isFinite(t) && (now - t) <= 15*60*1000){
      pushUnique(finals, m);
    }
  }
  finals.sort((a,b)=>eventMillis(b).ms - eventMillis(a).ms);

  // 2) live
  const ls = await v2Livescore("soccer");
  for (const m of (ls||[])) if (String(m.idLeague||"")==="4328") pushUnique(live, m);

  // 3) next round (often only 1)
  const next = await v1NextLeague(EPL_ID);
  for (const m of (next||[])){
    if (!futureOK(m, now)) continue;
    if (finals.length+live.length+sched.length >= n) break;
    pushUnique(sched, m);
  }

  // 4) wide day sweep (~16 weeks, all days)
  if (finals.length+live.length+sched.length < n){
    const dates = sweepDates(16, [0,1,2,3,4,5,6]);
    for (const ymd of dates){
      if (finals.length+live.length+sched.length >= n) break;
      const rows = await v1EventsDay("soccer", ymd);
      const keep = (rows||[])
        .filter(m => String(m.idLeague||"")==="4328")
        .filter(m => futureOK(m, now))
        .sort((a,b)=>eventMillis(a).ms - eventMillis(b).ms);
      for (const m of keep){
        if (finals.length+live.length+sched.length >= n) break;
        pushUnique(sched, m);
      }
    }
  }

  // 5) sequential fallback (up to 120 days / 60 calls)
  if (finals.length+live.length+sched.length < n){
    const need = n - (finals.length+live.length+sched.length);
    const today = new Date(); today.setUTCHours(0,0,0,0);
    let calls=0;
    for (let d=0; d<120 && calls<60 && (finals.length+live.length+sched.length)<n; d++){
      const ymd = new Date(today.getTime()+d*86400000).toISOString().slice(0,10);
      const rows = await v1EventsDay("soccer", ymd); calls++;
      const keep = (rows||[])
        .filter(m => String(m.idLeague||"")==="4328")
        .filter(m => futureOK(m, now))
        .sort((a,b)=>eventMillis(a).ms - eventMillis(b).ms);
      for (const m of keep){
        if (finals.length+live.length+sched.length >= n) break;
        pushUnique(sched, m);
      }
    }
  }

  const out = [...finals, ...live, ...sched].sort(sortForDisplay).slice(0,n);
  console.log(`[soccer:EPL] F=${finals.length} L=${live.length} S=${sched.length} -> out=${out.length}`);
  return out;
}

// ===== DEFAULT SINGLE-LEAGUE BUILDER (NBA/NHL/NFL) =====
async function buildSingle({ sport, leagueId, seasons, n }){
  const now=Date.now();
  const finals=[], live=[], sched=[];

  const past = await v1PastLeague(leagueId);
  for (const m of (past||[])){
    const t=eventMillis(m).ms;
    if (isFinalWord(m.strStatus||m.strProgress||"") && Number.isFinite(t) && (now - t) <= 15*60*1000){
      pushUnique(finals, m);
    }
  }
  finals.sort((a,b)=>eventMillis(b).ms - eventMillis(a).ms);

  const ls = await v2Livescore(sport);
  for (const m of (ls||[])) if (String(m.idLeague||"")===String(leagueId)) pushUnique(live, m);

  // cheap: next round
  const next = await v1NextLeague(leagueId);
  for (const m of (next||[])){ if (futureOK(m, now)) pushUnique(sched, m); if (finals.length+live.length+sched.length >= n) break; }

  // seasons
  for (const s of seasons){
    if (finals.length+live.length+sched.length >= n) break;
    const rows = await v1Season(leagueId, s);
    const fut = (rows||[]).filter(m=>futureOK(m, now)).sort((a,b)=>eventMillis(a).ms - eventMillis(b).ms);
    for (const m of fut){ pushUnique(sched, m); if (finals.length+live.length+sched.length >= n) break; }
  }

  // modest day sweep (<= 30 days or until filled)
  if (finals.length+live.length+sched.length < n){
    const today=new Date(); today.setUTCHours(0,0,0,0);
    let calls=0;
    for (let d=0; d<30 && (finals.length+live.length+sched.length)<n; d++){
      if (DAY_TOKENS<=0) break;
      const ymd=new Date(today.getTime()+d*86400000).toISOString().slice(0,10);
      const rows=await v1EventsDay(sport, ymd); DAY_TOKENS--; calls++;
      const fut=(rows||[])
        .filter(m => String(m.idLeague||"")===String(leagueId))
        .filter(m => futureOK(m, now))
        .sort((a,b)=>eventMillis(a).ms - eventMillis(b).ms);
      for (const m of fut){ pushUnique(sched, m); if (finals.length+live.length+sched.length >= n) break; }
    }
  }

  const out=[...finals, ...live, ...sched].sort(sortForDisplay).slice(0,n);
  console.log(`[${sport}:${leagueId}] F=${finals.length} L=${live.length} S=${sched.length} -> out=${out.length}`);
  return out;
}

// ===== CACHED WRAPPER =====
async function getBoardCached(key, builder, ttl = TTL.OUT){
  const c = getCache(key);
  if (c.hit && c.fresh) return c.val;
  const fetcher = async ()=>{ const data = await builder(); setCache(key, data, ttl); return data; };
  if (c.hit && !c.fresh){ withInflight(key, fetcher); return c.val; }
  return withInflight(key, fetcher);
}

// ===== FORMAT FOR CLIENT =====
function formatMatch(m){
  const home=m.strHomeTeam||m.homeTeam||m.strHome||"";
  const away=m.strAwayTeam||m.awayTeam||m.strAway||"";
  const s1=(m.intHomeScore??m.intHomeGoals);
  const s2=(m.intAwayScore??m.intAwayGoals);
  const ms=eventMillis(m).ms;
  return {
    team1: home, team2: away,
    score1: (s1==null)?"N/A":String(s1),
    score2: (s2==null)?"N/A":String(s2),
    headline: `${home} vs ${away} - ${statusOf(m)}`,
    start: Number.isFinite(ms) ? new Date(ms).toISOString() : null
  };
}

// ===== ROUTES =====

// Soccer (EPL-only)
app.get("/scores/soccer", async (req,res)=>{
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const bust = req.query.nocache ? `:${Date.now()}` : "";
    const key = `OUT:soccer:EPL:${n}${bust}`;
    const rows = await getBoardCached(key, ()=>buildSoccerEPLGuaranteed(n));
    res.json(rows.map(formatMatch));
  }catch(e){ console.error("soccer error:", e); res.status(500).json({error:"internal"}); }
});

// NBA / NFL / NHL (unchanged logic)
app.get("/scores/nba", async (req,res)=>{
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const key = `OUT:basketball:${L.NBA}:${n}`;
    const rows = await getBoardCached(key, ()=>buildSingle({ sport:"basketball", leagueId:L.NBA, seasons:seasonsCrossTriple(), n }));
    res.json(rows.map(formatMatch));
  }catch(e){ console.error("nba error:", e); res.status(500).json({error:"internal"}); }
});

app.get("/scores/nfl", async (req,res)=>{
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const key = `OUT:american_football:${L.NFL}:${n}`;
    const rows = await getBoardCached(key, ()=>buildSingle({ sport:"american_football", leagueId:L.NFL, seasons:seasonsNFL(), n }));
    res.json(rows.map(formatMatch));
  }catch(e){ console.error("nfl error:", e); res.status(500).json({error:"internal"}); }
});

app.get("/scores/nhl", async (req,res)=>{
  try{
    const n = Math.max(5, Math.min(10, parseInt(req.query.n || DEFAULT_COUNT,10) || DEFAULT_COUNT));
    const key = `OUT:ice_hockey:${L.NHL}:${n}`;
    const rows = await getBoardCached(key, ()=>buildSingle({ sport:"ice_hockey", leagueId:L.NHL, seasons:seasonsCrossTriple(), n }));
    res.json(rows.map(formatMatch));
  }catch(e){ console.error("nhl error:", e); res.status(500).json({error:"internal"}); }
});

app.get("/health",(_,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`Server listening on ${PORT} — ${BUILD}`));
