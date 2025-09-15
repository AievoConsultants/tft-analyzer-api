// src/riot.ts
// Low-level Riot helpers: hosts, fetchJson with retries, seed discovery, PUUID, match fetch.

export type Platform = "na1" | "euw1" | "eun1" | "kr" | "br1" | "oc1" | "jp1" | "la1" | "la2" | "ru" | "tr1";
export type Region   = "americas" | "europe" | "asia" | "sea";

export const PLATFORM_BASE: Record<Platform, string> = {
  na1: "https://na1.api.riotgames.com",
  euw1: "https://euw1.api.riotgames.com",
  eun1: "https://eun1.api.riotgames.com",
  kr: "https://kr.api.riotgames.com",
  br1: "https://br1.api.riotgames.com",
  oc1: "https://oc1.api.riotgames.com",
  jp1: "https://jp1.api.riotgames.com",
  la1: "https://la1.api.riotgames.com",
  la2: "https://la2.api.riotgames.com",
  ru: "https://ru.api.riotgames.com",
  tr1: "https://tr1.api.riotgames.com",
};

export const REGION_BASE: Record<Region, string> = {
  americas: "https://americas.api.riotgames.com",
  europe:   "https://europe.api.riotgames.com",
  asia:     "https://asia.api.riotgames.com",
  sea:      "https://sea.api.riotgames.com",
};

// Map platform -> region for TFT match endpoints.
export function platformToRegion(platform: Platform): Region {
  if (["na1", "br1", "oc1", "la1", "la2"].includes(platform)) return "americas";
  if (["euw1", "eun1", "tr1", "ru"].includes(platform))      return "europe";
  if (["kr", "jp1"].includes(platform))                       return "asia";
  return "americas";
}

export class HttpError extends Error {
  constructor(public status: number, public body: string, msg?: string) {
    super(msg ?? `HTTP ${status}: ${body?.slice(0, 200)}`);
  }
}

function sleep(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}

// Simple conservative throttling + retry (429, 5xx).
export async function fetchJson(url: string, init?: RequestInit, tries = 5, tag?: string): Promise<any> {
  const key = process.env.RIOT_API_KEY;
  const headers: any = { ...(init?.headers ?? {}), "X-Riot-Token": key! };

  // 150ms per call ~ 6.6 rps << 20 rps, also below 100/120s when averaged with retries.
  await sleep(150);

  const res = await fetch(url, { ...init, headers });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const status = res.status;

    // 429 / 5xx retry with backoff
    if ((status === 429 || (status >= 500 && status < 600)) && tries > 0) {
      const retryAfter = Number(res.headers.get("retry-after") || 1);
      const wait = Math.max(1500, retryAfter * 1000);
      console.warn(`[fetchJson] ${tag || url} -> ${status}. Retrying in ${wait}ms (tries=${tries - 1})`);
      await sleep(wait);
      return fetchJson(url, init, tries - 1, tag || url);
    }

    throw new HttpError(status, body, `[fetchJson] ${tag || url} failed: ${status}`);
  }

  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Collect Challenger/GM/Master + Diamond seeds. */
export async function listDiamondPlusSeeds(
  platform: Platform,
  opts: { target?: number; diamondPages?: number } = {},
): Promise<Array<{ summonerId: string; summonerName: string }>> {
  const { target = 300, diamondPages = 10 } = opts;
  const base = PLATFORM_BASE[platform];

  const seeds: Array<{ summonerId: string; summonerName: string }> = [];
  const seen = new Set<string>();

  async function push(entries: any[] | undefined, label: string) {
    const arr = Array.isArray(entries) ? entries : [];
    console.log(`[seed] ${label} entries=${arr.length}`);
    for (const e of arr) {
      const id = e?.summonerId;
      const name = e?.summonerName;
      if (id && name && !seen.has(id)) {
        seen.add(id);
        seeds.push({ summonerId: id, summonerName: name });
      }
    }
  }

  // Challenger / GM / Master lists
  for (const tier of ["challenger", "grandmaster", "master"] as const) {
    const url = `${base}/tft/league/v1/${tier}`;
    try {
      const data: any = await fetchJson(url, undefined, 5, tier);
      await push(data?.entries, tier);
    } catch (e: any) {
      console.warn(`[seed] ${tier} FAIL ${e.status ?? ""} ${e.message ?? e}`);
    }
  }

  // Diamond across divisions & pages
  const divisions = ["I", "II", "III", "IV"];
  for (const div of divisions) {
    for (let page = 1; page <= diamondPages && seeds.length < target; page++) {
      const url = `${base}/tft/league/v1/entries/DIAMOND/${div}?page=${page}`;
      try {
        const entries: any[] = await fetchJson(url, undefined, 5, `diamond ${div} p${page}`);
        await push(entries, `diamond ${div} page=${page}`);
      } catch (e: any) {
        console.warn(`[seed] diamond ${div} page=${page} FAIL ${e.status ?? ""} ${e.message ?? e}`);
      }
    }
  }

  console.log(`[seed] total unique seeds=${seeds.length}`);
  return seeds.slice(0, target);
}

export async function puuidFromSummonerId(platform: Platform, summonerId: string): Promise<string | null> {
  const base = PLATFORM_BASE[platform];
  const url = `${base}/tft/summoner/v1/summoners/${encodeURIComponent(summonerId)}`;
  try {
    const data = await fetchJson(url, undefined, 5, "summonerById");
    return data?.puuid ?? null;
  } catch (e: any) {
    if (e.status === 404) return null;
    console.warn(`[puuidFromSummonerId] ${summonerId} -> ${e.status ?? ""} ${e.message ?? e}`);
    return null;
  }
}

export async function matchIdsByPuuid(region: Region, puuid: string, count = 5): Promise<string[]> {
  const base = REGION_BASE[region];
  const url = `${base}/tft/match/v1/matches/by-puuid/${encodeURIComponent(puuid)}/ids?start=0&count=${count}`;
  try {
    const data: string[] = await fetchJson(url, undefined, 5, "matchIdsByPuuid");
    return Array.isArray(data) ? data : [];
  } catch (e: any) {
    console.warn(`[matchIdsByPuuid] ${puuid} -> ${e.status ?? ""} ${e.message ?? e}`);
    return [];
  }
}

export async function fetchMatch(region: Region, matchId: string): Promise<any | null> {
  const base = REGION_BASE[region];
  const url = `${base}/tft/match/v1/matches/${encodeURIComponent(matchId)}`;
  try {
    return await fetchJson(url, undefined, 5, `match ${matchId}`);
  } catch (e: any) {
    console.warn(`[fetchMatch] ${matchId} -> ${e.status ?? ""} ${e.message ?? e}`);
    return null;
  }
}
