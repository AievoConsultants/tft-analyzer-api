// src/riot.ts (replace the old listDiamondSeeds with this)
export async function listDiamondPlusSeeds(
  platform: Platform,
  opts: {
    target?: number;        // total seeds desired
    diamondPages?: number;  // how many pages per Diamond division to try
  } = {}
): Promise<Array<{ summonerId: string; summonerName: string }>> {
  const { target = 200, diamondPages = 10 } = opts;
  const base = PLATFORM_BASE[platform];

  const seeds: Array<{ summonerId: string; summonerName: string }> = [];
  const seen = new Set<string>();

  async function pushEntries(entries: any[] | undefined, label: string) {
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

  // 1) Challenger/Grandmaster/Master league lists (these are rich sources)
  for (const tier of ["challenger", "grandmaster", "master"] as const) {
    const url = `${base}/tft/league/v1/${tier}`;
    try {
      const data: any = await fetchJson(url);
      await pushEntries(data?.entries, tier);
    } catch (e: any) {
      console.warn(`[seed] ${tier} FAIL ${e.status ?? ""} ${e.message}`);
    }
  }

  // 2) Diamond entries across divisions with paging
  const divisions = ["I", "II", "III", "IV"];
  for (const div of divisions) {
    for (let page = 1; page <= diamondPages && seeds.length < target; page++) {
      const url = `${base}/tft/league/v1/entries/DIAMOND/${div}?page=${page}`;
      try {
        const entries: any[] = await fetchJson(url);
        await pushEntries(entries, `diamond ${div} page=${page}`);
      } catch (e: any) {
        console.warn(
          `[seed] diamond ${div} page=${page} FAIL ${e.status ?? ""} ${e.message}`
        );
      }
    }
  }

  console.log(`[seed] total unique seeds=${seeds.length}`);
  return seeds.slice(0, target);
}
