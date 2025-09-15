// src/updateCompStats.ts
/**
 * Build Top-N TFT comps from Diamond+ players.
 *
 * Env knobs (all optional):
 *   RIOT_API_KEY              (required)
 *   PLATFORM=na1              (routing: na1, euw1, kr, etc)
 *   REGION=americas           (americas|europe|asia|sea)
 *   TOP_N=30                  (how many comps to output)
 *   SEED_PLAYERS=120          (how many Diamond+ players to seed)
 *   COUNT_PER=3               (# of recent matches per seed player)
 *   MIN_SAMPLE=120            (min # matches required to publish)
 *   MAX_DIAMOND_PAGES_PER_DIV=2 (pages per Diamond division to fetch)
 *   SUMMONER_DELAY_MS=60      (ms delay between summoner lookups)
 *   MATCH_CONCURRENCY=10      (parallel match fetches)
 *   MATCH_DELAY_MS=0          (optional per-match delay)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RiotClient } from './riot';

type Division = 'I' | 'II' | 'III' | 'IV';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* --------------------- Config --------------------- */
const API_KEY = process.env.RIOT_API_KEY!;
if (!API_KEY) throw new Error('RIOT_API_KEY is required');

const PLATFORM = process.env.PLATFORM || 'na1';
const REGION   = process.env.REGION   || 'americas';

const TOP_N             = nEnv('TOP_N', 30);
const SEED_PLAYERS      = nEnv('SEED_PLAYERS', 120);
const COUNT_PER         = nEnv('COUNT_PER', 3);
const MIN_SAMPLE        = nEnv('MIN_SAMPLE', 120);
const MAX_DIAMOND_PAGES = nEnv('MAX_DIAMOND_PAGES_PER_DIV', 2);
const SUMMONER_DELAY_MS = nEnv('SUMMONER_DELAY_MS', 60);
const MATCH_CONCURRENCY = nEnv('MATCH_CONCURRENCY', 10);
const MATCH_DELAY_MS    = nEnv('MATCH_DELAY_MS', 0);

/* -------------------- Utilities ------------------- */

function nEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/** Simple concurrency pool without extra deps */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (x: T, index: number) => Promise<R>
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
          .finally(() => { active--; kick(); });
      }
    };
    kick();
  });
}

/* ----------------- Riot endpoints ----------------- */

const client = new RiotClient({
  apiKey: API_KEY,
  platform: PLATFORM,
  region: REGION,
});

async function ddVersion(): Promise<string> {
  const versions: string[] = await fetchJSON(
    'https://ddragon.leagueoflegends.com/api/versions.json'
  );
  return versions?.[0] ?? 'unknown';
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

/** Recent match IDs for a given puuid */
async function matchIdsBy
