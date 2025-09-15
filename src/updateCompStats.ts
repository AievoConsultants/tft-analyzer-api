// src/updateCompStats.ts
import fs from "node:fs/promises";
import path from "node:path";
import {
  listDiamondSeeds,
  puuidFromSummonerId,
  puuidFromName,
  matchIdsByPuuid,
  fetchMatch,
  Platform,
  Region,
} from "./riot";

const PLATFORM = (process.env.PLATFORM || "na1") as Platform;
const REGION = (process.env.REGION || "americas") as Region;

// knobs for rate/volume – safe defaults
const MIN_SAMPLE = Number(process.env.MIN_SAMPLE || 5);   // stop after >= this many matches
const SEED_PLAYERS = Number(process.env.SEED_PLAYERS || 20);
const COUNT_PER = Number(process.env.COUNT_PER || 3);     // matches per PUUID
const OUTPUT = path.join(process.cwd(), "public", "data", "comps.json");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const config = { PLATFORM, REGION, MIN_SAMPLE, SEED_PLAYERS, COUNT_PER };
  console.log("config:", JSON.stringify(config));

  // 1) Get a good pool of Diamond seeds (paged)
  const rawSeeds = await listDiamondSeeds(PLATFORM, { perPage: 50, pageFrom: 1, pageTo: 3 });
  console.log("Diamond+ seeds fetched:", rawSeeds.length);

  // Dedup by summonerId and limit to SEED_PLAYERS
  const seenIds = new Set<string>();
  const seeds = rawSeeds.filter(s => {
    if (!s.summonerId) return false;
    if (seenIds.has(s.summonerId)) return false;
    seenIds.add(s.summonerId);
    return true;
  }).slice(0, SEED_PLAYERS);
  console.log("[seed] collected", seeds.length, `(requested ${SEED_PLAYERS})`);

  // 2) Convert seeds to PUUIDs using TFT summoner API (platform route)
  const puuids: string[] = [];
  for (const seed of seeds) {
    let puuid: string | null = null;
    try {
      puuid = await puuidFromSummonerId(PLATFORM, seed.summonerId);
    } catch (e: any) {
      console.warn(`[puuid] by-id FAIL ${e.status ?? ""} for ${seed.summonerId} (${seed.summonerName})`);
      // fallback to by-name
      try {
        puuid = await puuidFromName(PLATFORM, seed.summonerName);
        console.log(`[puuid] by-name OK for ${seed.summonerName}`);
      } catch (e2: any) {
        console.warn(`[puuid] by-name FAIL ${e2.status ?? ""} for ${seed.summonerName}`);
      }
    }
    if (puuid) puuids.push(puuid);
    // small delay to be polite to rate limits
    await sleep(60);
  }
  console.log("PUUIDs collected:", puuids.length);

  // 3) Pull a few matches per PUUID (region route)
  const matchIds = new Set<string>();
  for (const p of puuids) {
    try {
      const ids = await matchIdsByPuuid(REGION, p, COUNT_PER);
      ids.forEach(id => matchIds.add(id));
      await sleep(60);
    } catch (e: any) {
      console.warn(`[matches] FAIL ${e.status ?? ""} for ${p}`);
    }
  }

  // Optionally fetch full matches (kept minimal to stay within limits)
  // const matches: any[] = [];
  // for (const id of matchIds) {
  //   try {
  //     matches.push(await fetchMatch(REGION, id));
  //     await sleep(60);
  //   } catch (e: any) {
  //     console.warn(`[match] FAIL ${e.status ?? ""} for ${id}`);
  //   }
  // }

  // 4) Write JSON (you can extend with real comp aggregation later)
  const out = {
    patch: "live",
    generated_at: new Date().toISOString(),
    sample: matchIds.size,  // number of unique match IDs collected
    comps: [] as any[],     // TODO: turn matches into comps when ready
  };

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUTPUT} with sample=${out.sample}`);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
