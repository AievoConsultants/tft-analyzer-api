
// scripts/update_comp_stats.mjs
import fs from "node:fs/promises";

const PLATFORM      = process.env.PLATFORM || "na1";
const REGION        = process.env.REGION   || "americas";
const RIOT_API_KEY  = process.env.RIOT_API_KEY;

const MIN_SAMPLE    = Number(process.env.MIN_SAMPLE    || 5);
const SEED_PLAYERS  = Number(process.env.SEED_PLAYERS  || 20);
const COUNT_PER     = Number(process.env.COUNT_PER     || 3);
const RATE_DELAY_MS = Number(process.env.RATE_DELAY_MS || 1300);
const QUEUES        = (process.env.QUEUES || "1100").split(",").map(s => Number(s.trim())).filter(Boolean);

if (!RIOT_API_KEY) {
  console.error("Missing RIOT_API_KEY"); process.exit(1);
}

const headers = { "X-Riot-Token": RIOT_API_KEY };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let last = 0;
async function throttle() {
  const wait = Math.max(0, RATE_DELAY_MS - (Date.now() - last));
  if (wait) await sleep(wait);
  last = Date.now();
}

async function rget(url) {
  await throttle();
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 429) {
      const ra = Number(res.headers.get("Retry-After") || "2") * 1000;
      console.warn(`[429] ${url} – retry in ${ra}ms`); await sleep(ra); continue;
    }
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`HTTP ${res.status} for ${url} :: ${txt.slice(0,200)}`);
    }
    return res.json();
  }
  throw new Error(`Too many 429s for ${url}`);
}

async function challengerSummonerIds() {
  const league = await rget(`https://${PLATFORM}.api.riotgames.com/tft/league/v1/challenger`);
  const ids = (league.entries || []).map(e => e.summonerId).slice(0, SEED_PLAYERS);
  console.log("Seed players:", ids.length);
  return ids;
}

async function toPuuid(summonerId) {
  const s = await rget(`https://${PLATFORM}.api.riotgames.com/tft/summoner/v1/summoners/${summonerId}`);
  return s.puuid;
}

// NOTE: /ids MUST NOT include queue params. Filter after fetching match detail.
async function matchIdsByPuuid(puuid) {
  return rget(`https://${REGION}.api.riotgames.com/tft/match/v1/matches/by-puuid/${puuid}/ids?start=0&count=${COUNT_PER}`);
}

async function fetchMatch(id) {
  return rget(`https://${REGION}.api.riotgames.com/tft/match/v1/matches/${id}`);
}

const boardKey = (units = []) =>
  units.map(u => u.character_id).filter(Boolean).sort().join("|");

async function main() {
  try {
    const summIds = await challengerSummonerIds();
    const puuids  = (await Promise.all(summIds.map(toPuuid))).filter(Boolean);

    const idBatches = await Promise.all(
      puuids.map(p => matchIdsByPuuid(p).catch(e => (console.warn("ids fail", e.message), [])))
    );
    const matchIds = [...new Set(idBatches.flat())];
    console.log("Pulled match IDs:", matchIds.length);

    const matches = [];
    for (const id of matchIds) {
      try {
        const m = await fetchMatch(id);
        const q = m?.info?.queue_id;
        if (!QUEUES.length || QUEUES.includes(q)) matches.push(m);
      } catch (e) {
        console.warn("match fail", id, e.message);
      }
    }
    console.log("Fetched matches:", matches.length);

    const counts = new Map();
    for (const m of matches) {
      for (const p of m?.info?.participants || []) {
        if (p.placement > 4) continue;          // top-4 only
        const key = boardKey(p.units);
        if (!key) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }

    const comps = [...counts.entries()]
      .map(([key, sample]) => ({ key, sample }))
      .filter(c => c.sample >= MIN_SAMPLE)
      .sort((a, b) => b.sample - a.sample)
      .slice(30);

    console.log("Total matches:", matches.length);
    console.log("Top comps:", comps.length);

    await fs.mkdir("public/data", { recursive: true });
    await fs.writeFile(
      "public/data/comps.json",
      JSON.stringify(
        {
          patch: "unknown",
          generated_at: new Date().toISOString(),
          sample: matches.length,
          comps
        },
        null, 2
      )
    );
  } catch (e) {
    console.error("FAILED:", e.message);
    process.exit(1);
  }
}

main();
