// src/updateCompStats.ts
import { fetchDiamondPlusSummonerIds, getPuuidBySummonerId, fetchMatchIdsByPuuid, sleep } from "./riot";
import fs from "node:fs";
import path from "node:path";

// Config via workflow env
const PLATFORM     = process.env.PLATFORM   || "na1";
const REGION       = process.env.REGION     || "americas";
const MIN_SAMPLE   = Number(process.env.MIN_SAMPLE ?? 120);
const SEED_PLAYERS = Number(process.env.SEED_PLAYERS ?? 20);
const COUNT_PER    = Number(process.env.COUNT_PER ?? 3);
const QUEUES       = Number(process.env.QUEUES ?? 1100); // ranked
const RIOT_API_KEY = process.env.RIOT_API_KEY || "";

// Output
const OUT_FILE = path.join("public", "data", "comps.json");

async function main() {
  if (!RIOT_API_KEY) throw new Error("RIOT_API_KEY is missing");

  const config = { PLATFORM, REGION, MIN_SAMPLE, SEED_PLAYERS, COUNT_PER, QUEUES };
  console.log("config:", JSON.stringify(config));

  // 1) Seed Diamond+
  const seedSummonerIds = await fetchDiamondPlusSummonerIds(PLATFORM, RIOT_API_KEY, SEED_PLAYERS);
  console.log(`Diamond+ encryptedSummonerIds fetched: ${seedSummonerIds.length}`);

  // 2) Resolve to PUUIDs (TFT Summoner API)
  const puuids: string[] = [];
  for (const sid of seedSummonerIds) {
    const puuid = await getPuuidBySummonerId(PLATFORM, sid, RIOT_API_KEY);
    if (puuid) puuids.push(puuid);
    await sleep(80);
  }
  console.log(`PUUIDs collected: ${puuids.length}`);

  // 3) Pull match IDs until MIN_SAMPLE reached (dedup)
  const seen = new Set<string>();
  for (const puuid of puuids) {
    const ids = await fetchMatchIdsByPuuid(REGION, puuid, COUNT_PER, QUEUES, RIOT_API_KEY);
    for (const id of ids) seen.add(id);
    console.log(`puuid ${puuid.slice(0,8)}*: +${ids.length} (total ${seen.size})`);
    if (seen.size >= MIN_SAMPLE) break;
    await sleep(80);
  }

  // 4) Write output
  const json = {
    patch: "live",
    generated_at: new Date().toISOString(),
    sample: seen.size,
    comps: [] as any[]  // we’re just counting sample for now
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(json, null, 2));
  console.log(`Wrote ${OUT_FILE} with sample=${json.sample}`);
}

main().catch(err => {
  console.error("FATAL", err);
  process.exit(1);
});
