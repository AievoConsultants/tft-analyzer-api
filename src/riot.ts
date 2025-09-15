// src/riot.ts
export type Platform =
  | "na1" | "euw1" | "eun1" | "br1" | "jp1" | "kr" | "la1" | "la2" | "oc1" | "tr1" | "ru";

export type Region = "americas" | "europe" | "asia" | "sea";

const PLATFORM_BASE: Record<Platform, string> = {
  na1: "https://na1.api.riotgames.com",
  euw1: "https://euw1.api.riotgames.com",
  eun1: "https://eun1.api.riotgames.com",
  br1: "https://br1.api.riotgames.com",
  jp1: "https://jp1.api.riotgames.com",
  kr: "https://kr.api.riotgames.com",
  la1: "https://la1.api.riotgames.com",
  la2: "https://la2.api.riotgames.com",
  oc1: "https://oc1.api.riotgames.com",
  tr1: "https://tr1.api.riotgames.com",
  ru: "https://ru.api.riotgames.com",
};

const REGION_BASE: Record<Region, string> = {
  americas: "https://americas.api.riotgames.com",
  europe: "https://europe.api.riotgames.com",
  asia: "https://asia.api.riotgames.com",
  sea: "https://sea.api.riotgames.com",
};

const KEY = process.env.RIOT_API_KEY!;
if (!KEY) throw new Error("RIOT_API_KEY env var missing");

async function fetchJson<T = any>(url: string): Promise<T> {
  const r = await fetch(url, {
    headers: { "X-Riot-Token": KEY },
    // Important so Actions never cache between runs:
    cache: "no-store",
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    const err = new Error(`HTTP ${r.status} for ${url}`);
    // @ts-ignore annotate for better logs
    err.status = r.status;
    // @ts-ignore
    err.body = text;
    throw err;
  }
  return r.json() as Promise<T>;
}

/**
 * Return a bunch of Diamond seeds (summonerId + name) by paging all divisions.
 * perPage keeps you under rate limits. Tune pageFrom/pageTo as you like.
 */
export async function listDiamondSeeds(
  platform: Platform,
  opts: { perPage?: number; pageFrom?: number; pageTo?: number } = {}
): Promise<Array<{ summonerId: string; summonerName: string }>> {
  const { perPage = 50, pageFrom = 1, pageTo = 3 } = opts;
  const base = PLATFORM_BASE[platform];
  const divisions = ["I", "II", "III", "IV"];
  const seeds: Array<{ summonerId: string; summonerName: string }> = [];

  for (const div of divisions) {
    for (let page = pageFrom; page <= pageTo; page++) {
      const url = `${base}/tft/league/v1/entries/DIAMOND/${div}?page=${page}`;
      try {
        const entries: any[] = await fetchJson(url);
        // entries contain {summonerId, summonerName, leaguePoints, ...}
        for (const e of entries.slice(0, perPage)) {
          if (e?.summonerId && e?.summonerName) {
            seeds.push({ summonerId: e.summonerId, summonerName: e.summonerName });
          }
        }
      } catch (e: any) {
        console.warn(`[seed] FAIL ${e.status ?? ""} ${e.message}`);
      }
    }
  }
  return seeds;
}

/** TFT route (platform) – convert encryptedSummonerId → puuid */
export async function puuidFromSummonerId(platform: Platform, encryptedSummonerId: string): Promise<string> {
  const base = PLATFORM_BASE[platform];
  const data = await fetchJson<any>(
    `${base}/tft/summoner/v1/summoners/${encodeURIComponent(encryptedSummonerId)}`
  );
  return data.puuid as string;
}

/** Fallback: by name (platform) */
export async function puuidFromName(platform: Platform, summonerName: string): Promise<string> {
  const base = PLATFORM_BASE[platform];
  const data = await fetchJson<any>(
    `${base}/tft/summoner/v1/summoners/by-name/${encodeURIComponent(summonerName)}`
  );
  return data.puuid as string;
}

/** Region route – get recent match IDs for a puuid */
export async function matchIdsByPuuid(region: Region, puuid: string, count = 20): Promise<string[]> {
  const base = REGION_BASE[region];
  return fetchJson<string[]>(
    `${base}/tft/match/v1/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=${count}`
  );
}

/** Region route – fetch one match */
export async function fetchMatch(region: Region, matchId: string): Promise<any> {
  const base = REGION_BASE[region];
  return fetchJson<any>(`${base}/tft/match/v1/matches/${encodeURIComponent(matchId)}`);
}
