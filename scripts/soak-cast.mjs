/**
 * Who plays which part in the soak (measure-soak.mts), by person index.
 *
 * People come in blocks of 20. The first block is the cast the soak has
 * always had, so 20 people measure what they always measured. Every further
 * full block of 20 plays the same parts again with its own people and its own
 * huddle channel. People 0 and 1 watch every channel and are the only ones
 * the send-to-receive time is measured on; their places in later blocks, the
 * last two places of every block, and anyone after the last full block only
 * listen.
 */

export const BLOCK = 20;

/** The parts for `people` people; types in soak-cast.d.mts. */
export function soakCast(people) {
  if (!(Number.isInteger(people) && people >= 18))
    throw new Error("the soak needs at least 18 people for its first block");
  // The first block needs only its 18 parts; later ones are counted whole.
  const count = 1 + Math.max(0, Math.floor((people - BLOCK) / BLOCK));
  const at = (b, places) => places.map((p) => b * BLOCK + p);
  const blocks = Array.from({ length: count }, (_, b) => ({
    talkers: at(b, [2, 3, 4, 5, 6, 7]),
    reactors: at(b, [8, 9]),
    uploader: b * BLOCK + 10,
    roamers: at(b, [11, 12]),
    visitor: b * BLOCK + 13,
    huddle: at(b, [14, 15, 16]),
    huddleChannel: b === 0 ? "standup" : `standup-${b + 1}`,
    reader: b * BLOCK + 17,
    // A block's reconnector drops any of its talkers, reactors, uploader or roamers.
    reconnectable: at(b, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  }));
  const watchers = [0, 1];
  const playing = new Set(watchers);
  for (const block of blocks)
    for (const person of [
      ...block.talkers,
      ...block.reactors,
      block.uploader,
      ...block.roamers,
      block.visitor,
      ...block.huddle,
      block.reader,
    ])
      playing.add(person);
  const listeners = Array.from({ length: people }, (_, i) => i).filter((i) => !playing.has(i));
  return { watchers, blocks, listeners };
}
