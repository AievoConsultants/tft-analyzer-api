// src/riot.ts

export type Platform =
  | 'na1' | 'br1' | 'la1' | 'la2'
  | 'euw1' | 'eun1' | 'tr1' | 'ru'
  | 'kr' | 'jp1' | 'oc1';

export type Region = 'americas' | 'europe' | 'asia' | 'sea';

const QUEUE = 'RANKED_TFT';

export interface LeagueEntry {
  summonerId: string;
  summonerName: string;
  leaguePoints: number;
  rank?: string;
  tier?: string;
}

export interface SummonerDTO { puuid: string; id: string; }

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

export async function riot<T>(url: string, key: string, tries = 3): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: { 'X-Riot-Token': key } });
    if (res.status === 429) { await sleep(1200); continue; }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return res.json() as Promise<T>;
  }
  throw new Error(`Rate limited too many times for ${url}`);
}

export function platformToRegion(p: Platform): Region {
  if (['na1', 'br1', 'la1', 'la2', 'oc1'].includes(p)) return 'americas';
  if (['euw1', 'eun1', 'tr1', 'ru'].includes(p)) return 'europe';
  if (['kr', 'jp1'].includes(p)) return 'asia';
  return 'sea';
}

export async function topTierIds(platform: Platform, key: string): Promise<string[]> {
  const base = `https://${platform}.api.riotgames.com/tft/league/v1`;
  const master = await riot<{ entries: LeagueEntry[] }>(`${base}/master?queue=${QUEUE}`, key).catch(() => ({ entries: [] as LeagueEntry[] }));
  const gm     = await riot<{ entries: LeagueEntry[] }>(`${base}/grandmaster?queue=${QUEUE}`, key).catch(() => ({ entries: [] as LeagueEntry[] }));
  const ch     = await riot<{ entries: LeagueEntry[] }>(`${base}/challenger?queue=${QUEUE}`, key).catch(() => ({ entries: [] as LeagueEntry[] }));
  const all = [...(master.entries || []), ...(gm.entries || []), ...(ch.entries || [])];
  return Array.from(new Set(all.map(e => e.summonerId)));
}

export async function diamondPlusIds(platform: Platform, key: string, pages = 1): Promise<string[]> {
  // DIAMOND I..IV pages + Master/GM/Challenger
  const base = `https://${platform}.api.riotgames.com/tft/league/v1/entries`;
  const divisions = ['I', 'II', 'III', 'IV'];
  const ids: string[] = [];

  for (const d of divisions) {
    for (let page = 1; page <= pages; page++) {
      const url = `${base}/DIAMOND/${d}?queue=${QUEUE}&page=${page}`;
      const entries = await riot<LeagueEntry[]>(url, key).catch(() => []);
      for (const e of entries) ids.push(e.summonerId);
      await sleep(120); // light throttle
    }
  }

  const top = await topTierIds(platform, key);
  return Array.from(new Set([...ids, ...top]));
}

export async function toPuuid(platform: Platform, key: string, encryptedSummonerId: string): Promise<string> {
  const dto = await riot<SummonerDTO>(
    `https://${platform}.api.riotgames.com/tft/summoner/v1/summoners/${encryptedSummonerId}`,
    key
  );
  return dto.puuid;
}

export async function recentMatchIds(region: Region, key: string, puuid: string, count = 5): Promise<string[]> {
  const url = `https://${region}.api.riotgames.com/tft/match/v1/matches/by-puuid/${puuid}/ids?start=0&count=${count}`;
  return riot<string[]>(url, key);
}

export type MatchDto = {
  info: {
    participants: Array<{
      puuid: string;
      units: Array<{ character_id: string; items: number[] }>;
      placement: number;
    }>;
    game_datetime: number;
    queue_id: number;
  };
  metadata: { match_id: string };
};

export async function fetchMatch(region: Region, key: string, matchId: string) {
  return riot<MatchDto>(`https://${region}.api.riotgames.com/tft/match/v1/matches/${matchId}`, key);
}
