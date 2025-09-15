import fs from "node:fs/promises";
import { RiotClient } from "./riot.js";
import { boardKey, CompsJson } from "./types.js";
import pLimit from "p-limit";

const ENV = (name: string, def?: string) => process.env[name] ?? def ?? "";

const PLATFORM      = ENV("PLATFORM", "na1");
const REGION        = ENV("REGION", "americas");
const RIOT_API_KEY  = process.env.RIOT_API_KEY;
const MIN_SAMPLE    = Number(ENV("MIN_SAMPLE", "5"));
const SEED_PLAYERS  = Number(ENV("SEED_PLAYERS", "20"));
const COUNT_PER     = Number(ENV("COUNT_PER", "3"));
const QUEUES        = (ENV("QUEUES", "1100"))
  .split(",").map(s => Number(s.trim())).filter(Boolean);

if (!RIOT_API_KEY) {
  console.error("Missing RIOT_API_KEY"); process.exit(1);
}

const client = new RiotClient(PLATFORM, REGION, RIOT_API_KEY);

async function latestPatch(): Promise<string> {
  try {
    const res = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
    const list = await res.json();
    // Take first, keep raw string (TFT shares LoL version stream)
    return Array.isArray(list) ? String(list[0] ?? "unknown") : "unknown";
  } catch {
    return "unknown";
  }
}

async function main() {
  console.log(JSON.stringify({ event: "config", PLATFORM, REGION, MIN_SAMPLE, SEED_PLAYERS, COUNT_PER, QUEUES }));

  const league = await client.challenger();
  const seeds  = league.entries.slice(0, SEED_PLAYERS).map(e => e.summonerId);
  console.log(JSON.stringify({ event: "seed_players", count: seeds.length }));

  // Summoner → PUUID
  const puuids: string[] = [];
  for (const id of seeds) {
    try {
      const s = await client.summoner(id);
      puuids.push(s.puuid);
    } catch (e: any) {
      console.warn("summoner_fail", id, e.message);
    }
  }

  // Pull match IDs
  const idSet = new Set<string>();
  for (const p of puuids) {
    try {
      const ids = await client.matchIds(p, 0, COUNT_PER);
      ids.forEach(id => idSet.add(id));
    } catch (e: any) {
      console.warn("ids_fail", p, e.message);
    }
  }
  const matchIds = [...idSet];
  console.log(JSON.stringify({ event: "match_ids", count: matchIds.length }));

  // Fetch matches (small concurrency)
  const limit = pLimit(4);
  const matches = (await Promise.all(
    matchIds.map(id => limit(async () => {
      try {
        return await client.match(id);
      } catch (e: any) {
        console.warn("match_fail", id, e.message);
        return null;
      }
    }))
  )).filter(Boolean) as Awaited<ReturnType<typeof client.match>>[];

  // Filter by queue (after fetching), aggregate top-4 boards
  const counts = new Map<string, number>();
  for (const m of matches) {
    const q = m.info.queue_id ?? 0;
    if (QUEUES.length && !QUEUES.includes(q)) continue;

    for (const p of m.info.participants) {
      if (p.placement > 4) continue;
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

  const patch = await latestPatch();

  const payload = CompsJson.parse({
    schema_version: 1,
    meta: {
      patch,
      generated_at: new Date().toISOString(),
      platform: PLATFORM,
      region: REGION,
      queue: QUEUES.length === 1 ? QUEUES[0] : undefined,
      sample_matches: matches.length
    },
    comps
  });

  await fs.mkdir("public/data", { recursive: true });
  await fs.writeFile("public/data/comps.json", JSON.stringify(payload, null, 2), "utf8");

  console.log(JSON.stringify({ event: "done", matches: matches.length, comps: comps.length }));
}

main().catch((e) => {
  console.error("FATAL", e?.stack || e?.message || e);
  process.exit(1);
});
