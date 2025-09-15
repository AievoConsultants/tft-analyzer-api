import { z } from "zod";

export const RiotSummoner = z.object({
  puuid: z.string(),
});
export type RiotSummoner = z.infer<typeof RiotSummoner>;

export const RiotLeagueEntry = z.object({
  summonerId: z.string(),
});
export type RiotLeagueEntry = z.infer<typeof RiotLeagueEntry>;

export const RiotChallengerLeague = z.object({
  entries: z.array(RiotLeagueEntry),
});
export type RiotChallengerLeague = z.infer<typeof RiotChallengerLeague>;

export const RiotUnit = z.object({
  character_id: z.string(),
});
export type RiotUnit = z.infer<typeof RiotUnit>;

export const RiotParticipant = z.object({
  placement: z.number(),
  units: z.array(RiotUnit),
});
export type RiotParticipant = z.infer<typeof RiotParticipant>;

export const RiotMatchInfo = z.object({
  queue_id: z.number().optional(),
  participants: z.array(RiotParticipant),
});
export type RiotMatchInfo = z.infer<typeof RiotMatchInfo>;

export const RiotMatch = z.object({
  info: RiotMatchInfo,
});
export type RiotMatch = z.infer<typeof RiotMatch>;

// ---------- Output schema (versioned) ----------

export const CompEntry = z.object({
  key: z.string(),   // "Aatrox|Ashe|…"
  sample: z.number() // count of top-4 boards with this exact champion set
});
export type CompEntry = z.infer<typeof CompEntry>;

export const CompsJson = z.object({
  schema_version: z.literal(1),
  meta: z.object({
    patch: z.string(),
    generated_at: z.string(),
    platform: z.string(),
    region: z.string(),
    queue: z.number().optional(),
    sample_matches: z.number()
  }),
  comps: z.array(CompEntry)
});
export type CompsJson = z.infer<typeof CompsJson>;

// board key: sorted champion ids (no items / tiers for now)
export const boardKey = (units: RiotUnit[]) =>
  units.map(u => u.character_id).filter(Boolean).sort().join("|");
