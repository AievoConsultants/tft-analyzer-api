// src/types.ts
// very small subset we need from the match payload

export interface TftUnit {
  character_id: string;
  items: number[];
  tier: number;     // star
}

export interface TftParticipant {
  puuid: string;
  placement: number;
  units: TftUnit[];
}

export interface TftInfo {
  queue_id: number;
  participants: TftParticipant[];
  game_version?: string;
}

export interface TftMatch {
  metadata: { match_id: string; participants: string[] };
  info: TftInfo;
}
