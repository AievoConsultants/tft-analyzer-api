// src/updateCompStats.ts
//
// Pull seeds (Challenger/GM/Master + Diamond pages), get PUUIDs,
// fetch match IDs & matches, compute a simple Top 30 comp table by wins,
// write public/data/comps.json

import {
  Platform,
  Region,
  platformToRegion,
  listDiamondPlusSeeds,
  puuidFromSummonerId,
  matchIdsByPuuid,
  fetchMatch,
} from "./riot";
import type { TftMatch, TftParticipant } from "./types";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// ----------------- Config -----------------
const PLATFORM = (process.env.PLATFORM as Platform) || "na1";
const REGION: Region = (process.env.REGION as Region) || platformToRegion(PLATFORM);

// How many matches minimum to aggregate before writing
const MIN_SAMPLE = Number(process.env.MIN_SAMPLE ?? 50);

// How many seed players to pull PUUIDs from
const SEED_PLAYERS = Number(process.env.SEED_PLAYERS ?? 30);

// For each PUUID, how many match IDs to fetch
const COUNT_PER = Number(process.env.COUNT_PER ?? 5);

// Which queues to include (1100 = Ranked Standard, 1110 = Hyper Roll, 1160 = Double Up)
const QUEUES = JSON.parse(process.env.QUEUES ?? "[1100]") as number[];

const OUTPUT = "public/data/comps.json";

// ----------------- Helpers -----------------

function compKeyFromParticipant(p: TftParticipant): string {
  // "composition" -> sorted list of unit character_id (without star/ items). You can refine later.
  const ids = (p.units || []).map(u => u.character_id).filter(Boolean);
  ids.sort();
  return ids.join("|");
}

type CompStats = {
  key: string;
  wins: number;
  games: number;
  sumPlacement: number;
};

function makeEmptyStats(key: string): CompStats {
  return { key, wins: 0, games: 0, sumPlacement: 0 };
}

// ----------------- Main -----------------

async function main() {
  console.log("config:", JSON.stringify({ PLATFORM, REGION, MIN_SAMPLE, SEED_PLAYERS, COUNT_PER, QUEUES }));

  // 1) Get seed summoners (IDs + names)
  const rawSeeds = await listDiamondPlusSeeds(PLATFORM, {
    target: SEED_PLAYERS * 3,   // try to over-sample to be safe
    diamondPages: 12,
  });

  if (!rawSeeds?.length) {
    console.warn("No seeds returned from Diamond+/league endpoints. Writing empty JSON.");
    await writeCompsJson({ patch: "live", generated_at: new Date().toISOString(), sample: 0, comps: [] });
    return;
  }

  // 2) SummonerId -> PUUID
  const seedSlice = rawSeeds.slice(0, SEED_PLAYERS);
  console.log(`[seed] collected ${seedSlice.length} (requested ${SEED_PLAYERS})`);

  const puuids: string[] = [];
  for (const s of seedSlice) {
    const puuid = await puuidFromSummonerId(PLATFORM, s.summonerId);
    if (puuid) puuids.push(puuid);
  }
  console.log(`PUUIDs collected: ${puuids.length}`);

  // 3) For each PUUID, fetch match IDs
  const allMatchIds = new Set<string>();
  for (const puuid of puuids) {
    const ids = await matchIdsByPuuid(REGION, puuid, COUNT_PER);
    ids.forEach(id => allMatchIds.add(id));
  }
  console.log(`unique match IDs: ${allMatchIds.size}`);

  // 4) Fetch matches and aggregate
  let sample = 0;
  const compMap = new Map<string, CompStats>();

  for (const id of allMatchIds) {
    const match = (await fetchMatch(REGION, id)) as TftMatch | null;
    if (!match?.info?.participants) continue;

    const info = match.info;
    if (!QUEUES.includes(info.queue_id)) continue;

    sample++;

    // winner (placement 1) contributes one win to that comp
    const winner = info.participants.find(p => p.placement === 1);
    if (winner) {
      const key = compKeyFromParticipant(winner);
      const s = compMap.get(key) ?? makeEmptyStats(key);
      s.wins += 1;
      s.games += 1;             // for now we only track the winner's comp
      s.sumPlacement += winner.placement;
      compMap.set(key, s);
    }

    if (sample >= MIN_SAMPLE) break;
  }

  // 5) Build "Top 30" comps
  const comps = [...compMap.values()]
    .sort((a, b) => b.wins - a.wins)
    .slice(0, 30)
    .map(({ key, wins, games, sumPlacement }) => ({
      units: key.split("|"),
      wins,
      games,
      avg_place: games > 0 ? +(sumPlacement / games).toFixed(2) : null,
    }));

  const out = {
    patch: "live",
    generated_at: new Date().toISOString(),
    sample,
    comps,
  };

  await writeCompsJson(out);
  console.log(`Wrote ${OUTPUT} with sample=${sample}`);
}

async function writeCompsJson(data: any) {
  const dir = dirname(OUTPUT);
  await mkdir(dir, { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(data, null, 2), "utf8");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
