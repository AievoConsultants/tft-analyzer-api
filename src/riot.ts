// src/riot.ts
// Minimal Riot API helpers used by updateCompStats.ts

const RIOT_API_KEY = process.env.RIOT_API_KEY!;
if (!RIOT_API_KEY) {
  throw new Error("RIOT_API_KEY env var is required");
}

// Defaults can be overridden in the workflow env
const PLATFORM = (process.env.PLATFORM ?? "na1").toLowerCase();     // e.g., na1, euw1, kr
const REGION   = (process.env.REGION ?? "americas").toLowerCase();  // americas | europe | asia | sea

// Simple fetch with basic 429 handling (uses Node 20 global fetch)
async function riot<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "X-Riot-Token": RIOT_API_KEY,
    },
  });

  // Basic 429 retry support
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? 1);
    await new Promise((r) => setTimeout(r, (retryAfter + 0.5) * 1000));
    return riot<T>(url);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Riot API error ${res.status} ${res.statusText} for ${url}\n${text}`);
  }
  return res.json() as Promise<T>;
}

/** Data Dragon latest version (e.g., "15.18.1") */
export async function getDDVersion(): Promise<string> {
  const versions = await riot<string[]>("https://ddragon.leagueoflegends.com/api/versions.json");
  if (!versions.length) throw new Error("No DD versions returned");
  return versions[0];
}

/** Get match ids for a puuid from Match-V5 */
export async function getMatchIds(puuid: string, count = 20, queue?: number): Promise<string[]> {
  const qs = new URLSearchParams({
    count: String(count),
  });
  if (queue) qs.set("queue", String(queue));

  const url = `https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?${qs.toString()}`;
  return riot<string[]>(url);
}

/** Get a single match payload */
export async function getMatch(matchId: string): Promise<any> {
  const url = `https://${REGION}.api.riotgames.com/lol/match/v5/matches/${matchId}`;
  return riot<any>(url);
}

/** Convenience: fetch many matches (sequential to be gentle; you can parallelize with your rateLimiter) */
export async function getMatches(matchIds: string[]): Promise<any[]> {
  const out: any[] = [];
  for (const id of matchIds) {
    out.push(await getMatch(id));
  }
  return out;
}
