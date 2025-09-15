// src/riot.ts

export interface RiotOptions {
  apiKey?: string;
  region?: 'americas' | 'europe' | 'asia' | 'sea';
  platform?: string; // e.g., na1, euw1, kr
}

export class RiotClient {
  private apiKey: string;
  private region: string;
  private platform: string;

  constructor(opts: RiotOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.RIOT_API_KEY ?? '';
    this.region = (opts.region ?? (process.env.REGION ?? 'americas')).toLowerCase();
    this.platform = (opts.platform ?? (process.env.PLATFORM ?? 'na1')).toLowerCase();

    if (!this.apiKey) {
      throw new Error('RIOT_API_KEY env var is required');
    }
  }

  /** Low-level request with basic 429 retry */
  private async request<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      headers: {
        'X-Riot-Token': this.apiKey,
      },
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? 1);
      await new Promise((r) => setTimeout(r, (retryAfter + 0.5) * 1000));
      return this.request<T>(url);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Riot API error ${res.status} ${res.statusText} for ${url}\n${text}`);
    }
    return res.json() as Promise<T>;
  }

  /** Data Dragon latest version (e.g., "15.18.1") */
  async getDDVersion(): Promise<string> {
    const versions = await this.request<string[]>(
      'https://ddragon.leagueoflegends.com/api/versions.json'
    );
    if (!versions.length) throw new Error('No DD versions returned');
    return versions[0];
  }

  /** Match-V5: match ids for a puuid */
  async getMatchIds(puuid: string, count = 20, queue?: number): Promise<string[]> {
    const qs = new URLSearchParams({ count: String(count) });
    if (queue) qs.set('queue', String(queue));

    const url = `https://${this.region}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?${qs.toString()}`;
    return this.request<string[]>(url);
  }

  /** Match-V5: a single match payload */
  async getMatch(matchId: string): Promise<any> {
    const url = `https://${this.region}.api.riotgames.com/lol/match/v5/matches/${matchId}`;
    return this.request<any>(url);
  }

  /** Convenience: get many matches sequentially (you can parallelize with your rate limiter) */
  async getMatches(matchIds: string[]): Promise<any[]> {
    const out: any[] = [];
    for (const id of matchIds) {
      out.push(await this.getMatch(id));
    }
    return out;
  }
}

/** Factory if you prefer */
export function createRiotClient(opts?: RiotOptions) {
  return new RiotClient(opts);
}

/** Function-style exports (optional, for places that import helpers directly) */
const defaultClient = new RiotClient();
export const getDDVersion = () => defaultClient.getDDVersion();
export const getMatchIds = (puuid: string, count?: number, queue?: number) =>
  defaultClient.getMatchIds(puuid, count, queue);
export const getMatches = (ids: string[]) => defaultClient.getMatches(ids);
