// src/riot.ts

type Division = "I" | "II" | "III" | "IV";

export interface Seed {
  summonerId: string;      // encryptedSummonerId
  summonerName?: string;
}

async function getJson<T>(url: string, apiKey: string): Promise<T> {
  const res = await fetch(url, { headers: { "X-Riot-Token": apiKey } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText} ${body.slice(0,120)}`);
  }
  return res.json() as Promise<T>;
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Collect Diamond+ seeds (id + name) with decent paging & logging. */
export async function fetchDiamondPlusSeeds(
  platform: string,           // e.g. "na1"
  apiKey: string,
  maxSeeds: number
): Promise<Seed[]> {
  const base = `https://${platform}.api.riotgames.com/tft/league/v1`;
  const seeds: Seed[] = [];

  async function collectSingleTier(path: string) {
    const url = `${base}/${path}`;
    try {
      const data = await getJson<{ entries: { summonerId: string; summonerName: string }[] }>(url, apiKey);
      for (const e of data.entries ?? []) {
        seeds.push({ summonerId: e.summonerId, summonerName: e.summonerName });
        if (seeds.length >= maxSeeds) return;
      }
    } catch (err: any) {
      console.log(`[seed] FAIL ${url} -> ${err.message}`);
    }
  }

  // Master+ (no paging)
  for (const t of ["challenger", "grandmaster", "master"]) {
    await collectSingleTier(t);
    if (seeds.length >= maxSeeds) break;
    await sleep(150);
  }

  // Diamond (paged)
  const divs: Division[] = ["I", "II", "III", "IV"];
  for (const div of divs) {
    for (let page = 1; page <= 10 && seeds.length < maxSeeds; page++) {
      const url = `${base}/entries/DIAMOND/${div}?page=${page}`;
      try {
        const entries = await getJson<{ summonerId: string; summonerName: string }[]>(url, apiKey);
        if (!entries.length) break;
        for (const e of entries) {
          seeds.push({ summonerId: e.summonerId, summonerName: e.summonerName });
          if (seeds.length >= maxSeeds) break;
        }
      } catch (err: any) {
        console.log(`[seed] FAIL ${url} -> ${err.message}`);
        break; // move on to next division if this page errors repeatedly
      }
      await sleep(120);
    }
    if (seeds.length >= maxSeeds) break;
  }

  // Dedupe by id and crop
  const seen = new Set<string>();
  const out: Seed[] = [];
  for (const s of seeds) {
    if (!seen.has(s.summonerId)) {
      out.push(s);
      seen.add(s.summonerId);
      if (out.length >= maxSeeds) break;
    }
  }
  console.log(`[seed] collected ${out.length} (requested ${maxSeeds})`);
  return out;
}

/** Resolve PUUID: try by encryptedSummonerId first, fallback to by-name. */
export async function resolvePuuid(
  platform: string,
  seed: Seed,
  apiKey: string
): Promise<string | null> {
  // 1) by encryptedSummonerId
  let url = `https://${platform}.api.riotgames.com/tft/summoner/v1/summoners/${encodeURIComponent(seed.summonerId)}`;
  try {
    const res = await fetch(url, { headers: { "X-Riot-Token": apiKey } });
    if (res.ok) {
      const j = await res.json();
      return j?.puuid ?? null;
    }
    if (res.status !== 404) {
      console.log(`[puuid] by-id FAIL ${res.status} for ${seed.summonerId}`);
    }
  } catch (e: any) {
    console.log(`[puuid] by-id ERR ${e.message}`);
  }

  // 2) fallback: by-name (names can change, but works often)
  if (seed.summonerName) {
    url = `https://${platform}.api.riotgames.com/tft/summoner/v1/summoners/by-name/${encodeURIComponent(seed.summonerName)}`;
    try {
      const res = await fetch(url, { headers: { "X-Riot-Token": apiKey } });
      if (res.ok) {
        const j = await res.json();
        return j?.puuid ?? null;
      }
      console.log(`[puuid] by-name FAIL ${res.status} for ${seed.summonerName}`);
    } catch (e: any) {
      console.log(`[puuid] by-name ERR ${e.message}`);
    }
  }

  return null;
}

/** Fetch recent match IDs for a PUUID from regional route. */
export async function fetchMatchIdsByPuuid(
  region: string,              // e.g. "americas"
  puuid: string,
  count: number,
  queue: number | undefined,   // e.g. 1100 for ranked
  apiKey: string
): Promise<string[]> {
  const params = new URLSearchParams({ count: String(count) });
  if (queue != null) params.set("queue", String(queue));
  const url = `https://${region}.api.riotgames.com/tft/match/v1/matches/by-puuid/${encodeURIComponent(puuid)}/ids?${params}`;
  try {
    const res = await fetch(url, { headers: { "X-Riot-Token": apiKey } });
    if (!res.ok) {
      console.log(`[ids] FAIL ${res.status} puuid=${puuid.slice(0,8)} url=${url}`);
      return [];
    }
    return res.json() as Promise<string[]>;
  } catch (e: any) {
    console.log(`[ids] ERR ${e.message}`);
    return [];
  }
}
