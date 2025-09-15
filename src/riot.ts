// src/riot.ts
// Diamond+ seed collector with tolerant ID extraction.
// Works for Challenger / Grandmaster / Master / Diamond I-IV.
// Uses standard Riot endpoints and logs progression for GH Actions visibility.

type Seed = {
  summonerId: string;
  summonerName: string;
};

// Minimal platform/region -> host tables (extend if you need more)
const PLATFORM_HOST: Record<string, string> = {
  na1: "https://na1.api.riotgames.com",
  euw1: "https://euw1.api.riotgames.com",
  eun1: "https://eun1.api.riotgames.com",
  kr: "https://kr.api.riotgames.com",
  jp1: "https://jp1.api.riotgames.com",
  br1: "https://br1.api.riotgames.com",
  la1: "https://la1.api.riotgames.com",
  la2: "https://la2.api.riotgames.com",
  oc1: "https://oc1.api.riotgames.com",
  tr1: "https://tr1.api.riotgames.com",
  ru: "https://ru.api.riotgames.com",
};

const REGION_HOST: Record<string, string> = {
  americas: "https://americas.api.riotgames.com",
  europe: "https://europe.api.riotgames.com",
  asia: "https://asia.api.riotgames.com",
  sea: "https://sea.api.riotgames.com",
};

/** Small polite delay to stay well under rate limits */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function riotGET<T>(host: string, path: string, apiKey: string): Promise<T> {
  const url = `${host}${path}`;
  const res = await fetch(url, {
    headers: {
      "X-Riot-Token": apiKey,
      "Accept": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText} ${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as T;
}

/** Tolerant extractors so we don't miss IDs due to small schema shifts */
function extractId(e: any): string | null {
  return (
    e?.summonerId ??              // common on entries
    e?.encryptedSummonerId ??     // older naming
    e?.summonerID ??              // variations seen in some envs
    e?.id ??                      // some league payloads
    null
  );
}
function extractName(e: any): string {
  return (
    e?.summonerName ??
    e?.playerOrTeamName ??
    e?.gameName ??
    "unknown"
  );
}

/**
 * Pull seeds from Challenger / Grandmaster / Master league endpoints.
 */
async function pushTopLeagues(platform: string, apiKey: string, seeds: Seed[], seen: Set<string>) {
  const host = PLATFORM_HOST[platform];
  if (!host) throw new Error(`Unsupported platform: ${platform}`);

  const kinds = ["challenger", "grandmaster", "master"] as const;
  for (const kind of kinds) {
    try {
      const path = `/tft/league/v1/${kind}`;
      const json = await riotGET<any>(host, path, apiKey);

      // entries array is usually at json.entries
      const entries = Array.isArray(json?.entries) ? json.entries : [];
      const sampleKeys = entries.length ? Object.keys(entries[0]).slice(0, 10).join(",") : "";
      console.log(`[seed] ${kind} entries=${entries.length}${sampleKeys ? ` sample keys: ${sampleKeys}` : ""}`);

      let added = 0, skipped = 0;
      for (const e of entries) {
        const id = extractId(e);
        if (id && !seen.has(id)) {
          seen.add(id);
          seeds.push({ summonerId: id, summonerName: extractName(e) });
          added++;
        } else {
          skipped++;
        }
      }
      console.log(`[seed] ${kind}: added=${added}, skipped=${skipped}`);
    } catch (err: any) {
      console.log(`[seed] ${kind} fetch failed: ${err?.message || err}`);
    }
    await sleep(120); // small pause between heavy endpoints
  }
}

/**
 * Pull seeds from DIAMOND I–IV using paginated entries endpoint.
 * We walk pages until an empty page is hit or maxPages is reached.
 */
async function pushDiamond(platform: string, apiKey: string, seeds: Seed[], seen: Set<string>) {
  const host = PLATFORM_HOST[platform];
  const divisions = ["I", "II", "III", "IV"];
  const maxPages = 12; // Riot returns ~205 per page; 10-12 pages covers most snapshots

  for (const div of divisions) {
    for (let page = 1; page <= maxPages; page++) {
      try {
        const path = `/tft/league/v1/entries/DIAMOND/${div}?page=${page}`;
        const arr = await riotGET<any[]>(host, path, apiKey);

        const entries = Array.isArray(arr) ? arr : [];
        console.log(`[seed] diamond ${div} page=${page} entries=${entries.length}`);

        if (!entries.length) break; // no more pages for this division

        let added = 0, skipped = 0;
        // Log one sample per division for debugging
        if (page === 1 && entries.length) {
          const sampleKeys = Object.keys(entries[0]).slice(0, 10).join(",");
          console.log(`[seed] diamond ${div} sample keys: ${sampleKeys}`);
        }
        for (const e of entries) {
          const id = extractId(e);
          if (id && !seen.has(id)) {
            seen.add(id);
            seeds.push({ summonerId: id, summonerName: extractName(e) });
            added++;
          } else {
            skipped++;
          }
        }
        console.log(`[seed] diamond ${div} page=${page} added=${added}, skipped=${skipped}`);
      } catch (err: any) {
        console.log(`[seed] diamond ${div} page=${page} failed: ${err?.message || err}`);
      }
      await sleep(80); // polite delay between pages
    }
  }
}

/**
 * Public function your updateCompStats.ts should call.
 * It aggregates Challenger + GM + Master + Diamond I–IV.
 */
export async function listDiamondPlusSeeds(platform: string): Promise<Seed[]> {
  const apiKey = process.env.RIOT_API_KEY || "";
  if (!apiKey) throw new Error("RIOT_API_KEY is not set");

  const seeds: Seed[] = [];
  const seen = new Set<string>();

  console.log(`[seed] collecting Diamond+ seeds for platform=${platform}`);
  await pushTopLeagues(platform, apiKey, seeds, seen);
  await pushDiamond(platform, apiKey, seeds, seen);

  console.log(`[seed] total unique seeds=${seen.size}`);
  return seeds;
}

/**
 * Optional helpers you may already be using in updateCompStats.ts
 * (Included here so you can use a single import from './riot'.)
 */

export async function getPUUIDBySummonerId(platform: string, summonerId: string): Promise<string | null> {
  const host = PLATFORM_HOST[platform];
  const apiKey = process.env.RIOT_API_KEY || "";
  if (!host || !apiKey) return null;
  try {
    const p = `/tft/summoner/v1/summoners/${encodeURIComponent(summonerId)}`;
    const s = await riotGET<any>(host, p, apiKey);
    return s?.puuid || null;
  } catch {
    return null;
  }
}

export async function matchIdsByPUUID(region: string, puuid: string, count: number): Promise<string[]> {
  const host = REGION_HOST[region];
  const apiKey = process.env.RIOT_API_KEY || "";
  if (!host || !apiKey) return [];
  try {
    const p = `/tft/match/v1/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=${count}`;
    const ids = await riotGET<any[]>(host, p, apiKey);
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

export async function fetchMatch(region: string, matchId: string): Promise<any | null> {
  const host = REGION_HOST[region];
  const apiKey = process.env.RIOT_API_KEY || "";
  if (!host || !apiKey) return null;
  try {
    const p = `/tft/match/v1/matches/${encodeURIComponent(matchId)}`;
    return await riotGET<any>(host, p, apiKey);
  } catch {
    return null;
  }
}
