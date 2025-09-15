// ---- Add near your other interfaces ----
export interface TFTLeagueEntry {
  leagueId?: string;
  queueType?: string; // e.g. RANKED_TFT
  tier?: 'IRON'|'BRONZE'|'SILVER'|'GOLD'|'PLATINUM'|'DIAMOND'|'MASTER'|'GRANDMASTER'|'CHALLENGER';
  rank?: 'I'|'II'|'III'|'IV';
  summonerId: string;         // encrypted
  summonerName: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  freshBlood?: boolean;
  inactive?: boolean;
  veteran?: boolean;
  hotStreak?: boolean;
}

type Division = 'I'|'II'|'III'|'IV';

// ---- Add these methods inside RiotClient ----

/** TFT: master ladder (no divisions) */
async master(): Promise<TFTLeagueEntry[]> {
  const url = `https://${this.platform}.api.riotgames.com/tft/league/v1/master`;
  const data = await this.request<{ entries: TFTLeagueEntry[] }>(url);
  return data.entries ?? [];
}

/** TFT: grandmaster ladder (no divisions) */
async grandmaster(): Promise<TFTLeagueEntry[]> {
  const url = `https://${this.platform}.api.riotgames.com/tft/league/v1/grandmaster`;
  const data = await this.request<{ entries: TFTLeagueEntry[] }>(url);
  return data.entries ?? [];
}

/** TFT: entries for tier/division with pagination (used for Diamond I–IV) */
async leagueEntries(
  tier: 'DIAMOND'|'PLATINUM'|'GOLD'|'SILVER'|'BRONZE'|'IRON',
  division: Division,
  page = 1,
): Promise<TFTLeagueEntry[]> {
  const url = `https://${this.platform}.api.riotgames.com/tft/league/v1/entries/${tier}/${division}?page=${page}`;
  return this.request<TFTLeagueEntry[]>(url);
}

/**
 * Summoner IDs for Diamond+:
 *  - First pulls Master/Grandmaster/Challenger
 *  - Then iterates Diamond I–IV pages until `target` is reached
 */
async diamondPlusSummonerIds(target = 500, maxDiamondPagesPerDiv = 2): Promise<string[]> {
  const ids = new Set<string>();

  // Master+ first (fast, no paging)
  for (const fn of [this.master.bind(this), this.grandmaster.bind(this), this.challenger.bind(this)]) {
    const entries = await fn();
    for (const e of entries) {
      ids.add(e.summonerId);
      if (ids.size >= target) break;
    }
    if (ids.size >= target) break;
  }

  // Then Diamond I–IV, a few pages each (each page can be up to ~200 entries)
  if (ids.size < target) {
    const DIVS: Division[] = ['I', 'II', 'III', 'IV'];
    for (const div of DIVS) {
      for (let page = 1; page <= maxDiamondPagesPerDiv; page++) {
        const entries = await this.leagueEntries('DIAMOND', div, page);
        if (!entries.length) break;        // no more pages in this div
        for (const e of entries) {
          ids.add(e.summonerId);
          if (ids.size >= target) break;
        }
        if (ids.size >= target) break;
      }
      if (ids.size >= target) break;
    }
  }

  return [...ids];
}

/** Turn encrypted summonerIds → PUUIDs (respecting some delay for rate-limits) */
async toPUUIDsFromSummonerIds(summonerIds: string[], delayMs = 50): Promise<string[]> {
  const out: string[] = [];
  for (const id of summonerIds) {
    const s = await this.getSummonerById(id);
    out.push(s.puuid);
    if (delayMs) await this.sleep(delayMs);
  }
  return out;
}

/** Small sleep helper the class can use */
private sleep(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}
