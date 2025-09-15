// src/updateCompStats.ts
import {
  diamondPlusIds,
  platformToRegion,
  toPuuid,
  recentMatchIds,
  fetchMatch,
  type Platform,
  type Region
} from './riot';

type Config = {
  PLATFORM: Platform;
  REGION: Region;
  RIOT_API_KEY: string;
  MIN_SAMPLE: number;
  COUNT_PER: number;
  SEED_PLAYERS: number;
  QUEUES: number[]; // queue ids to keep (ranked TFT is 1100)
};

const cfg: Config = {
  PLATFORM: (process.env.PLATFORM as Platform) || 'na1',
  REGION:
    (process.env.REGION as Region) ||
    platformToRegion((process.env.PLATFORM as Platform) || 'na1'),
  RIOT_API_KEY: process.env.RIOT_API_KEY || '',
  MIN_SAMPLE: Number(process.env.MIN_SAMPLE || 120),
  COUNT_PER: Number(process.env.COUNT_PER || 3),
  SEED_PLAYERS: Number(process.env.SEED_PLAYERS || 20),
  QUEUES: process.env.QUEUES ? JSON.parse(process.env.QUEUES) : [1100]
};

if (!cfg.RIOT_API_KEY) {
  throw new Error('Missing RIOT_API_KEY (GitHub secret).');
}

const wait = (ms: number) => new Promise(res => setTimeout(res, ms));

type CompKey = string;
type CompAgg = {
  key: CompKey;
  plays: number;
  sum_place: number;
  top4: number;
  examples: string[];
};

function compKey(units: Array<{ character_id: string }>): CompKey {
  // Define a comp by sorted list of unit character_ids
  return units.map(u => u.character_id).sort().join('|');
}

async function main() {
  console.log(JSON.stringify({
    event: 'config',
    PLATFORM: cfg.PLATFORM,
    REGION: cfg.REGION,
    MIN_SAMPLE: cfg.MIN_SAMPLE,
    COUNT_PER: cfg.COUNT_PER,
    SEED_PLAYERS: cfg.SEED_PLAYERS,
    QUEUES: cfg.QUEUES
  }));

  // 1) Diamond+ summoner IDs (encryptedSummonerId)
  const seedIds = await diamondPlusIds(cfg.PLATFORM, cfg.RIOT_API_KEY, 1);
  console.log(`Diamond+ encryptedSummonerIds fetched: ${seedIds.length}`);

  // 2) Convert to puuids (cap by SEED_PLAYERS)
  const puuids: string[] = [];
  for (const id of seedIds) {
    if (puuids.length >= cfg.SEED_PLAYERS) break;
    try {
      const p = await toPuuid(cfg.PLATFORM, cfg.RIOT_API_KEY, id);
      puuids.push(p);
    } catch {
      // ignore
    }
    await wait(120);
  }
  console.log(`PUUIDs collected: ${puuids.length}`);

  // 3) Pull recent match ids for each puuid
  const matchIdSet = new Set<string>();
  for (const p of puuids) {
    try {
      const ids = await recentMatchIds(cfg.REGION, cfg.RIOT_API_KEY, p, cfg.COUNT_PER);
      ids.forEach(id => matchIdSet.add(id));
    } catch {
      // ignore
    }
    await wait(140);
  }
  console.log(`Unique match IDs: ${matchIdSet.size}`);

  // 4) Fetch each match, aggregate comps
  const comps = new Map<CompKey, CompAgg>();

  for (const matchId of Array.from(matchIdSet)) {
    try {
      const m = await fetchMatch(cfg.REGION, cfg.RIOT_API_KEY, matchId);
      if (!cfg.QUEUES.includes(m.info.queue_id)) continue;

      for (const part of m.info.participants) {
        const key = compKey(part.units);
        if (!key) continue;

        const rec = comps.get(key) || {
          key,
          plays: 0,
          sum_place: 0,
          top4: 0,
          examples: []
        };

        rec.plays += 1;
        rec.sum_place += part.placement;
        if (part.placement <= 4) rec.top4 += 1;
        if (rec.examples.length < 3) rec.examples.push(m.metadata.match_id);

        comps.set(key, rec);
      }
    } catch {
      // ignore
    }
    await wait(160);
  }

  // 5) Transform → top 30 by best avg placement
  const table = Array.from(comps.values()).map(r => {
    const avg = r.sum_place / Math.max(1, r.plays);
    const top4Rate = r.top4 / Math.max(1, r.plays);
    return {
      comp: r.key.split('|'),            // unit ids
      plays: r.plays,
      avg_place: Number(avg.toFixed(2)),
      top4: Number((top4Rate * 100).toFixed(1)),
      examples: r.examples
    };
  });

  table.sort((a, b) => a.avg_place - b.avg_place);
  const best = table.slice(0, 30);
  const sample = best.reduce((s, x) => s + x.plays, 0);

  const out = {
    patch: 'live',                       // you can replace with dd-version if you want
    generated_at: new Date().toISOString(),
    sample,
    comps: best
  };

  const fs = await import('node:fs/promises');
  await fs.mkdir('public/data', { recursive: true });
  await fs.writeFile('public/data/comps.json', JSON.stringify(out, null, 2));
  console.log('Wrote public/data/comps.json');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
