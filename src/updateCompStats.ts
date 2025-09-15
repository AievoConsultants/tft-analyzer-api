// src/updateCompStats.ts
/**
 * Build Top-N TFT comps from Diamond+ players and write public/data/comps.json
 *
 * Env knobs (optional unless noted):
 *   RIOT_API_KEY              (required)
 *   PLATFORM=na1              (routing: na1, euw1, kr, etc)
 *   REGION=americas           (americas|europe|asia|sea)
 *   TOP_N=30
 *   SEED_PLAYERS=120
 *   COUNT_PER=3
 *   MIN_SAMPLE=120
 *   MAX_DIAMOND_PAGES_PER_DIV=2
 *   SUMMONER_DELAY_MS=60
 *   MATCH_CONCURRENCY=10
 *   MATCH_DELAY_MS=0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RiotClient } from './riot';

/* --------------------- Types --------------------- */

interface TFTMatch {
  metadata: { match_id: string; participants: string[] };
  info: {
    game_datetime: number;
    patch: string;
    participants: Array<{
      puuid: string;
      placement: number;
      units: Array<{
        character_id: string; // e.g., "TFT10_Garen"
        tier?: number;
        name?: string;
      }>;
    }>;
  };
}

type CompKey = string;

interface CompAgg {
  key: CompKey;
  count: number;
  units: string[];
}

/* --------------------- Config -------------------- */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function nEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

const API_KEY = process.env.RIOT_API_KEY!;
if (!API_KEY) throw new Error('RIOT_API_KEY is required');

const PLATFORM = process.env.PLATFORM || 'na1';
const REGION = process.env.REGION || 'americas';

const TOP_N = nEnv('TOP_N', 30);
const SEED_PLAYERS = nEnv('SEED_PLAYERS', 120);
const COUNT_PER = nEnv('COUNT_PER', 3);
const MIN_SAMPLE = nEnv('MIN_SAMPLE', 120);
const MAX_DIAMOND_PAGES = nEnv('MAX_DIAMOND_PAGES_PER_DIV', 2);
const SUMMONER_DELAY_MS = nEnv('SUMMONER_DELAY_MS', 60);
const MATCH_CONCURRENCY = nEnv('MATCH_CONCURRENCY', 10);
const MATCH_DELAY_MS = nEnv('MATCH_DELAY_MS', 0);

/* ------------------- Utilities ------------------- */

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (x: T, idx: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let active = 0;

  return new Promise((resolve, reject) => {
    const kick = () => {
      if (next === items.length && active === 0) return resolve(out);
      while (active < limit && next < items.length) {
        const i = next++;
        active++;
        fn(items[i], i)
          .then((r) => (out[i] = r))
          .catch(reject)
          .finally(() => {
            active--;
            kick();
          });
      }
    };
    kick();
  });
}

async function fetchJSON<T>(url: string, riot = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (riot) headers['X-Riot-Token'] = API_KEY;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}\n${body}`);
  }
  return res.json() as Promise<T>;
}

async function ddVersion(): Promise<string> {
  const versions: string[] = await fetchJSON(
    'https://ddragon.leagueoflegends.com/api/versions.json'
  );
  return versions?.[0] ?? 'unknown';
}

async function matchIdsByPUUID(puuid: string, count: number): Promise<string[]> {
  const url = `https://${REGION}.api.riotgames.com/tft/match/v1/matches/by-puuid/${puuid}/ids?start=0&count=${count}`;
  return fetchJSON<string[]>(url, true);
}

async function getMatch(matchId: string): Promise<TFTMatch> {
  const url = `https://${REGION}.api.riotgames.com/tft/match/v1/matches/${matchId}`;
  return fetchJSON<TFTMatch>(url, true);
}

/* ---------------- Aggregation helpers ------------- */

function normUnitId(id: string): string {
  const idx = id.lastIndexOf('_');
  return idx >= 0 ? id.slice(idx + 1) : id;
}

function winnerComp(match: TFTMatch): CompAgg | null {
  const p = match.info.participants.find((x) => x.placement === 1);
  if (!p) return null;
  const units = (p.units || [])
    .map((u) => normUnitId(u.character_id))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  if (units.length === 0) return null;
  const key = units.join('+');
  return { key, count: 1, units };
}

/* ----------------------- Main --------------------- */

async function main(): Promise<void> {
  console.log(
    JSON.stringify(
      {
        event: 'config',
        PLATFORM,
        REGION,
        MIN_SAMPLE,
        SEED_PLAYERS,
        COUNT_PER,
      },
      null,
      0
    )
  );

  const client = new RiotClient({
    apiKey: API_KEY,
    platform: PLATFORM,
    region: REGION,
  });

  const dd = await ddVersion();
  console.log('DD version:', dd);

  // 1) Seed Diamond+ players
  const summonerIds = await client.diamondPlusSummonerIds(SEED_PLAYERS, MAX_DIAMOND_PAGES);
  console.log(`Seeded summonerIds (Diamond+): ${summonerIds.length}`);

  // 2) Convert to PUUIDs with small pacing
  const puuids = await client.toPUUIDsFromSummonerIds(summonerIds, SUMMONER_DELAY_MS);
  console.log(`Resolved PUUIDs: ${puuids.length}`);

  // 3) Collect recent match IDs (de-duped)
  const allIds = new Set<string>();
  for (const p of puuids) {
    try {
      const ids = await matchIdsByPUUID(p, COUNT_PER);
      ids.forEach((id) => allIds.add(id));
    } catch {
      // ignore single PUUID failures
    }
    if (MATCH_DELAY_MS) await sleep(MATCH_DELAY_MS);
  }
  const matchIds = [...allIds];
  console.log(`Total unique match IDs: ${matchIds.length}`);

  // 4) Fetch matches with limited concurrency
  const matches = await mapPool(
    matchIds,
    MATCH_CONCURRENCY,
    async (id) => {
      try {
        const m = await getMatch(id);
        if (MATCH_DELAY_MS) await sleep(MATCH_DELAY_MS);
        return m;
      } catch {
        return null;
      }
    }
  );

  const valid = matches.filter(Boolean) as TFTMatch[];
  console.log(`Fetched matches: ${valid.length}`);

  if (valid.length < MIN_SAMPLE) {
    console.log('No comps met MIN_SAMPLE; keeping previous comps.json if any.');
    return; // Exit normally; the “commit if changed” step will no-op
  }

  // 5) Aggregate winner comps
  const counts = new Map<CompKey, CompAgg>();
  for (const m of valid) {
    const agg = winnerComp(m);
    if (!agg) continue;
    const prev = counts.get(agg.key);
    if (prev) prev.count += 1;
    else counts.set(agg.key, agg);
  }

  const top = [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_N);

  const out = {
    patch: dd,
    generated_at: new Date().toISOString(),
    sample: valid.length,
    comps: top.map((c, i) => ({
      comp_id: `COMP_${String(i + 1).padStart(3, '0')}`,
      times: c.count,
      units: c.units,
    })),
  };

  const outDir = path.resolve(__dirname, '../public/data');
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, 'comps.json');
  await fs.writeFile(outFile, JSON.stringify(out, null, 2), 'utf8');

  console.log(`Wrote ${outFile}`);
}

/* -------------------- Entrypoint ------------------- */

main().catch((err) => {
  console.error('FATAL:', err?.stack || err?.message || err);
  process.exit(1);
});
