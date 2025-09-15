// scripts/update_comp_stats.mjs
// Pulls TFT matches, aggregates Top-30 comps, writes public/data/comps.json
// ENV: RIOT_API_KEY, PLATFORM (na1/euw1/...), REGION (americas/europe/asia/sea), MIN_SAMPLE (e.g. 150)

import fs from "node:fs/promises";

// Small helper for Riot requests with key
async function rget(url) {
  const r = await fetch(url, { headers: { "X-Riot-Token": process.env.RIOT_API_KEY } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// Load Data Dragon item/champ indexes (names + image filenames)
async function loadStatic(ddVersion) {
  const [items, champs] = await Promise.all([
    fetch(`https://ddragon.leagueoflegends.com/cdn/${ddVersion}/data/en_US/tft-item.json`).then(r=>r.json()),
    fetch(`https://ddragon.leagueoflegends.com/cdn/${ddVersion}/data/en_US/tft-champion.json`).then(r=>r.json())
  ]);
  const itemById = {};
  Object.values(items.data).forEach(it => { itemById[it.id] = it.name; });

  const champByApi = {};
  Object.values(champs.data).forEach(ch => { champByApi[(ch.apiName || ch.id)] = ch.name; });

  return { itemById, champByApi };
}

const norm = s => String(s||"").toLowerCase().trim();
const keyOf = arr => arr.map(norm).sort().join("|"); // canonical unordered key

// Pull a seed of high-elo PUUIDs
async function getSeedPuuids() {
  const plat = process.env.PLATFORM || "na1";
  const league = await rget(`https://${plat}.api.riotgames.com/tft/league/v1/challenger`);
  const summonerIds = league.entries.slice(0, 200).map(e => e.summonerId);
  const chunks = [];
  for (let i=0;i<summonerIds.length;i+=50) chunks.push(summonerIds.slice(i, i+50));

  const puuids = [];
  for (const batch of chunks) {
    const detailed = await Promise.all(batch.map(id =>
      rget(`https://${plat}.api.riotgames.com/tft/summoner/v1/summoners/${id}`).catch(()=>null)
    ));
    detailed.forEach(d => d && puuids.push(d.puuid));
  }
  return [...new Set(puuids)];
}

// Pull recent matches for those PUUIDs (deduped)
async function pullMatches(puuids, countPer=20) {
  const region = process.env.REGION || "americas";
  const idSet = new Set();
  for (const p of puuids) {
    const ids = await rget(`https://${region}.api.riotgames.com/tft/match/v1/matches/by-puuid/${p}/ids?count=${countPer}`).catch(()=>[]);
    ids.forEach(id => idSet.add(id));
  }
  const matchIds = [...idSet];
  const matches = [];
  for (const id of matchIds) {
    const m = await rget(`https://${region}.api.riotgames.com/tft/match/v1/matches/${id}`).catch(()=>null);
    if (m) matches.push(m);
  }
  return matches;
}

// Aggregate by "comp" (unordered set of unit names, up to 9)
function aggregate(matches, champByApi, itemById) {
  const compMap = new Map();

  for (const m of matches) {
    const info = m.info;
    if (!info) continue;
    // Keep ranked standard when queue_id present
    if (typeof info.queue_id === "number" && info.queue_id !== 1100) continue;

    for (const p of info.participants || []) {
      const placement = p.placement;
      const units = (p.units || []).slice(0, 9).map(u => ({
        api: u.character_id,
        name: champByApi[u.character_id] || u.character_id,
        tier: u.tier || u.star_level || 1,
        items: (u.itemNames && u.itemNames.length ? u.itemNames
                 : (u.items || []).map(id => itemById[id]).filter(Boolean))
      }));

      const compKey = keyOf(units.map(u => u.name));
      if (!compMap.has(compKey)) compMap.set(compKey, { games:0, sumPlace:0, top4:0, wins:0, units: new Map() });
      const agg = compMap.get(compKey);

      agg.games += 1;
      agg.sumPlace += placement;
      if (placement <= 4) agg.top4 += 1;
      if (placement === 1) agg.wins += 1;

      for (const u of units) {
        if (!agg.units.has(u.name)) agg.units.set(u.name, { games:0, sumTier:0, itemSets: new Map() });
        const ua = agg.units.get(u.name);
        ua.games += 1;
        ua.sumTier += (u.tier || 1);

        const setKey = keyOf((u.items || []).slice(0,3));
        if (setKey) ua.itemSets.set(setKey, (ua.itemSets.get(setKey)||0) + 1);
      }
    }
  }

  const comps = [];
  for (const [key, agg] of compMap.entries()) {
    const names = key.split("|").map(s => s.charAt(0).toUpperCase()+s.slice(1));

    const units = [...agg.units.entries()].map(([name, ua]) => {
      const topSets = [...ua.itemSets.entries()]
        .sort((a,b)=>b[1]-a[1]).slice(0,2)
        .map(([k]) => k.split("|").map(s => s.replace(/_/g," ")));
      return {
        name,
        avg_stars: +(ua.sumTier / ua.games).toFixed(2),
        pick_rate: +(ua.games / agg.games).toFixed(2),
        common_items: topSets
      };
    });

    comps.push({
      id: names.slice(0,4).join("_").replace(/\s+/g,"").toUpperCase(),
      name: names.slice(0,4).join(" "),
      avg_place: +(agg.sumPlace / agg.games).toFixed(2),
      top4_rate: +(agg.top4 / agg.games).toFixed(2),
      win_rate: +(agg.wins / agg.games).toFixed(2),
      games: agg.games,
      units: units.sort((a,b)=>b.pick_rate-a.pick_rate).slice(0,9)
    });
  }
  return comps;
}

// Main
(async () => {
  const ddVersion = (await fetch("https://ddragon.leagueoflegends.com/api/versions.json").then(r=>r.json()))[0];
  const { itemById, champByApi } = await loadStatic(ddVersion);
  const puuids = await getSeedPuuids();
  const matches = await pullMatches(puuids, 20);

  const comps = aggregate(matches, champByApi, itemById)
    .filter(c => c.games >= (parseInt(process.env.MIN_SAMPLE||"150")))
    .sort((a,b)=> a.avg_place - b.avg_place)
    .slice(0, 30);

  const out = {
    patch: ddVersion,
    generated_at: new Date().toISOString(),
    sample: matches.length,
    comps
  };

  await fs.mkdir("public/data", { recursive: true });
  await fs.writeFile("public/data/comps.json", JSON.stringify(out, null, 2));
  console.log("Wrote public/data/comps.json with", comps.length, "comps");
})();
