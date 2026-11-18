/** Types for soak-cast.mjs, for measure-soak.mts. */
export interface CastBlock {
  talkers: number[];
  reactors: number[];
  uploader: number;
  roamers: number[];
  visitor: number;
  huddle: number[];
  huddleChannel: string;
  reader: number;
  reconnectable: number[];
}
export const BLOCK: number;
export function soakCast(people: number): {
  watchers: number[];
  blocks: CastBlock[];
  listeners: number[];
};
