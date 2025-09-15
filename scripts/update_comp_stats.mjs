
// scripts/update_comp_stats.mjs
// Builds public/data/comps.json from live Riot TFT matches, with rate-limit safety.
// Requires Node 20+ (global fetch) and a RIOT_API_KEY provided by the workflow.

import fs from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Tunables from env (safe defaults for dev keys) -------------------------
const PLATFORM       = process.env.PLATFORM || "na1";      // na1, euw1, kr, ...
const REGION         = process.env.REGION   || "americas"; // americas, europe, asia, sea
const MIN_SAMPLE     = parseInt(process.env.MIN_SAMPLE  || "10"); // min games per comp
const SEED_PLAYERS   = parseInt(process.env.SEED_PLAYERS|| "20"); // # of ladder players to seed
const COUNT_PER      = parseInt(process.env.COUNT_PER   || "3");  // matches per PUUID
const RATE_DELAY_MS  = parseInt(process.env.RATE_DELAY_MS|| "1300"); // per-host spacing (~92 req/2min)
const KEEP_QUEUES    = (process.env.QUEUES || "1100").split(",").map(s=>parseInt(s.trim(),10)); // default Standard only

// ---- Per-host throttling + retry on 429 ------------------------------------
const lastHit = new Map(); // host -> last timestamp

async function throttleFor(url) {
  const host = new URL(url).host;   // e.g., na1.api..., americas.api...
  const now  = Date.now();
  const next = (lastHit.get(host) || 0) + RATE_DELAY_MS;
  const wait = Math.max(0, next - now);
  if (wait) await sleep(wait);
  lastHit.set(host, Date.now());
}

async function rget(url) {
  await throttleFor(url);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, { headers: { "X-Riot-Token": process.env.RIOT_API_KEY } });
    if (r.status === 429) {
      const ra = parseInt(r.headers.get("Retry-After") || "2", 10) * 1000;
      await sleep(ra || 2000);
      continue;
    }
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }
  throw new Error(`429 throttled too many times for ${url}`);
}

// ---- Static data (DD) -------------------------------------------------------
async function loadStatic() {
  const versions = await fetch("https://ddragon.leagueoflegends.com/api/versions.json").then(r=>r.json());
  const ddVersion = versions[0];

  const [items, champs] = await Promise.all([
    fetch(`https://ddragon.leagueoflegends.com/cdn/${ddVersion}/data/en_US/tft-item.json`).then(r=>r.json()),
    fetch(`https://ddragon.leagueoflegends.com/cdn/${ddVersion}/data/en_US/tft-champion.json`).then(r=>r.json()),
  ]);

  const itemById = {};
  Object.values(items.data).forEach(it => { itemById[it.id] = it.name; });

  const champByApi = {};
  Object.values(champs.data).forEach(ch => { champByApi[ch.apiName || ch.id] = ch.name; });

  return { ddVersion, itemById, champByApi };
}

const norm = (s) => String(s || "").toLowerCase().trim();
const keyOf = (arr) => arr.map(norm).sort().join("|"); // canonical unordered key

// ---- Seed players -----------------------------------------------------------
async function getSeedPuuids() {
  async function leagueIds(path) {
    try {
      const data = await rget(`https://${PLATFORM}.api.riotgames.com/tft/league/v1/${path}`);
      return (data.entries || data).map(e => e.summonerId);
    } catch { return []; }
  }

  let summonerIds = await leagueIds("challenger");
  if (summonerIds.length < 50)  summonerIds = summonerIds.concat(await leagueIds("grandmaster"));
  if (summonerIds.length < 100) summonerIds = summonerIds.concat(await leagueIds("master"));

  // Fallback: a page of Diamond I
  if (summonerIds.length < 150) {
    try {
      const page = await rget(`https://${PLATFORM}.api.riotgames.com/tft/league/v1/entries/DIAMOND/I?page=1`);
      summonerIds = summonerIds.concat(page.map(e => e.summonerId));
    } catch {}
  }

  const chosen = summonerIds.slice(0, SEED_PLAYERS);
  const puuids = [];
  for (const id of chosen) {
    const s = await rget(`https://${PLATFORM}.api.riotgames.com/tft/summoner/v1/summoners/${id}`).catch(()=>null);
    if (s?.puuid) puuids.push(s.puuid);
  }
  return [...new Set(puuids)];
}

// ---- Pull matches (IDs then details) ---------------------------------------
async function pullMatches(puuids) {
  const idSet = new Set();

  for (const p of puuids) {
    const ids = await rget(`https://${REGION}.api.riotgames.com/tft/match/v1/matches/by-puuid/${p}/ids?count=${COUNT_PER}`)
      .catch(()=>[]);
    ids.forEach(id => idSet.add(id));
    if (idSet.size >= 120) break; // hard cap; keeps detail calls under limit
  }

  const matchIds = [...idSet];
  console.log("Pulled match IDs:", matchIds.length);

  const matches = [];
  for (const id of matchIds) {
    const m = await rget(`https://${REGION}.api.riotgames.com/tft/match/v1/matches/${id}`).catch(()=>null);
    if (m) matches.push(m);
  }
  console.log("Fetched matches:", matches.length);
  return matches;
}

// ---- Aggregate to comps -----------------------------------------------------
function aggregate(matches, champByApi, itemById) {
  const compMap = new Map();

  for (const m of matches) {
    const info = m?.info;
    if (!info) continue;

    // Filter queue: Standard by default (1100). Allow multiple if provided.
    if (typeof info.queue_id === "number" && !KEEP_QUEUES.includes(info.queue_id)) continue;

    for (const p of (info.participants || [])) {
      const placement = p.placement;
      const units = (p.units || []).slice(0, 9).map(u => ({
        api: u.character_id,
        name: champByApi[u.character_id] || u.character_id,
        tier: u.tier || u.star_level || 1,
        items: (u.itemNames && u.itemNames.length
                  ? u.itemNames
                  : (u.items || []).map(id => itemById[id]).filter(Boolean))
      }));

      const compKey = keyOf(units.map(u => u.name));
      if (!compMap.has(compKey)) compMap.set(compKey, { games:0, sumPlace:0, top4:0, wins:0, units: new Map() });
      const agg = compMap.get(compKey);

      agg.games += 1;
      agg.sumPlace += placement;
      if (placement <= 4) agg.top4 += 1;
      if (placement === 1) agg.wins += 1;

      for (const u of units) {
        if (!agg.units.has(u.name)) agg.units.set(u.name, { games:0, sumTier:0, itemSets: new Map() });
        const ua = agg.units.get(u.name);
        ua.games += 1;
        ua.sumTier += (u.tier || 1);

        const setKey = keyOf((u.items || []).slice(0,3));
        if (setKey) ua.itemSets.set(setKey, (ua.itemSets.get(setKey) || 0) + 1);
      }
    }
  }

  const comps = [];
  for (const [key, agg] of compMap.entries()) {
    if (agg.games < MIN_SAMPLE) continue;

    const names = key.split("|").map(s => s.charAt(0).toUpperCase() + s.slice(1));
    const units = [...agg.units.entries()].map(([name, ua]) => {
      const topSets = [...ua.itemSets.entries()]
        .sort((a,b)=>b[1]-a[1]).slice(0,2)
        .map(([k]) => k.split("|").map(s => s.replace(/_/g," ")));
      return {
        name,
        avg_stars: +(ua.sumTier / ua.games).toFixed(2),
        pick_rate: +(ua.games / agg.games).toFixed(2),
        common_items: topSets
      };
    });

    comps.push({
      id: names.slice(0,4).join("_").replace(/\s+/g,"").toUpperCase(),
      name: names.slice(0,4).join(" "),
      avg_place: +(agg.sumPlace / agg.games).toFixed(2),
      top4_rate: +(agg.top4 / agg.games).toFixed(2),
      win_rate: +(agg.wins / agg.games).toFixed(2),
      games: agg.games,
      units: units.sort((a,b)=>b.pick_rate-a.pick_rate).slice(0,9)
    });
  }

  // Sort best → worst by avg_place then by games
  return comps.sort((a,b)=> (a.avg_place - b.avg_place) || (b.games - a.games)).slice(0,30);
}

// ---- Main -------------------------------------------------------------------
(async () => {
  const { ddVersion, itemById, champByApi } = await loadStatic();
  const puuids   = await getSeedPuuids();
  const matches  = await pullMatches(puuids);
  const comps    = aggregate(matches, champByApi, itemById);

  console.log("DD version:", ddVersion);
  console.log("Total matches:", matches.length);
  console.log("Top comps:", comps.length);

  const out = {
    patch: ddVersion,
    generated_at: new Date().toISOString(),
    sample: matches.length,
    comps
  };

  await fs.mkdir("public/data", { recursive: true });
const tmp = "public/data/comps.tmp.json";
await fs.writeFile(tmp, JSON.stringify(out, null, 2), "utf8");

if (comps.length > 0) {
  await fs.rename(tmp, "public/data/comps.json");
  console.log("Wrote public/data/comps.json with", comps.length, "comps");
} else {
  console.warn("No comps met MIN_SAMPLE; keeping previous comps.json if any.");
  try { await fs.unlink(tmp); } catch {}
}

})().catch((e) => {
  console.error("update_comp_stats failed:", e);
  process.exit(1);
});
