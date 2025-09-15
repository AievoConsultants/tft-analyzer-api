// src/riot.ts

type Division = "I" | "II" | "III" | "IV";
type Tier = "CHALLENGER" | "GRANDMASTER" | "MASTER" | "DIAMOND";

// Generic GET with API key
async function getJson<T>(url: string, apiKey: string): Promise<T> {
  const res = await fetch(url, { headers: { "X-Riot-Token": apiKey } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// Optional small delay to be gentle with limits (tweak if needed)
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Use TFT *league* endpoints to get Diamond+ encryptedSummonerIds */
export async function fetchDiamondPlusSummonerIds(
  platform: string,      // e.g. "na1"
  apiKey: string,
  maxSeeds: number       // stop when we have enough
): Promise<string[]> {
  const base = `https://${platform}.api.riotgames.com/tft/league/v1`;
  const out: string[] = [];

  // Master+ (no paging)
  for (const path of ["challenger", "grandmaster", "master"]) {
    try {
      const data = await getJson<{ entries: { summonerId: string }[] }>(`${base}/${path}`, apiKey);
      for (const e of data.entries) {
        out.push(e.summonerId);
        if (out.length >= maxSeeds) return Array.from(new Set(out));
      }
    } catch { /* skip transient failures */ }
    await sleep(200);
  }

  // Diamond (paged by division)
  const divs: Division[] = ["I", "II", "III", "IV"];
  for (const div of divs) {
    let page = 1;
    while (out.length < maxSeeds) {
      try {
        const url = `${base}/entries/DIAMOND/${div}?page=${page}`;
        const entries = await getJson<{ summonerId: string }[]>(url, apiKey);
        if (!entries.length) break;
        for (const e of entries) {
          out.push(e.summonerId);
          if (out.length >= maxSeeds) return Array.from(new Set(out));
        }
      } catch {
        break; // move on if division/page unavailable
      }
      page++;
      await sleep(150);
    }
  }

  return Array.from(new Set(out));
}

/** Use *TFT* Summoner API (not LoL!) to turn encryptedSummonerId -> PUUID */
export async function getPuuidBySummonerId(
  platform: string,            // e.g. "na1"
  encryptedSummonerId: string,
  apiKey: string
): Promise<string | null> {
  const url = `https://${platform}.api.riotgames.com/tft/summoner/v1/summoners/${encodeURIComponent(encryptedSummonerId)}`;
  const res = await fetch(url, { headers: { "X-Riot-Token": apiKey } });
  if (!res.ok) return null;   // 404s happen for stale ids; just skip
  const data = await res.json();
  return data?.puuid ?? null;
}

/** Get match IDs for a PUUID from regional route (americas/europe/asia/sea) */
export async function fetchMatchIdsByPuuid(
  region: string,     // e.g. "americas"
  puuid: string,
  count: number,      // number of matches to pull per PUUID
  queue: number,      // e.g. 1100 (ranked)
  apiKey: string
): Promise<string[]> {
  const params = new URLSearchParams({ count: String(count) });
  if (queue != null) params.set("queue", String(queue));
  const url = `https://${region}.api.riotgames.com/tft/match/v1/matches/by-puuid/${encodeURIComponent(puuid)}/ids?${params}`;
  const res = await fetch(url, { headers: { "X-Riot-Token": apiKey } });
  if (!res.ok) return [];
  return res.json() as Promise<string[]>;
}
