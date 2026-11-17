import assert from "node:assert/strict";
import { test } from "node:test";
import { soakCast } from "./soak-cast.mjs";

const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

test("20 people are exactly the cast the soak has always had", () => {
  assert.deepEqual(soakCast(20), {
    watchers: [0, 1],
    blocks: [
      {
        talkers: [2, 3, 4, 5, 6, 7],
        reactors: [8, 9],
        uploader: 10,
        roamers: [11, 12],
        visitor: 13,
        huddle: [14, 15, 16],
        huddleChannel: "standup",
        reader: 17,
        reconnectable: range(2, 13),
      },
    ],
    listeners: [18, 19],
  });
});

test("18 people are still one block, with nobody left over", () => {
  const cast = soakCast(18);
  assert.equal(cast.blocks.length, 1);
  assert.deepEqual(cast.listeners, []);
});

test("each further block of 20 plays every part again, with its own huddle channel", () => {
  const cast = soakCast(40);
  assert.equal(cast.blocks.length, 2);
  const [first, second] = cast.blocks;
  assert.deepEqual(second, {
    talkers: [22, 23, 24, 25, 26, 27],
    reactors: [28, 29],
    uploader: 30,
    roamers: [31, 32],
    visitor: 33,
    huddle: [34, 35, 36],
    huddleChannel: "standup-2",
    reader: 37,
    reconnectable: range(22, 33),
  });
  assert.equal(first.huddleChannel, "standup");
  // The latency watchers stay people 0 and 1; their places in later blocks listen.
  assert.deepEqual(cast.watchers, [0, 1]);
  assert.deepEqual(cast.listeners, [18, 19, 20, 21, 38, 39]);
});

test("people after the last full block listen", () => {
  const forty = soakCast(40);
  const fifty = soakCast(50);
  assert.deepEqual(fifty.blocks, forty.blocks);
  assert.deepEqual(fifty.listeners, [...forty.listeners, ...range(40, 50)]);
});

test("200 people are ten blocks, and everyone has exactly one place", () => {
  const cast = soakCast(200);
  assert.equal(cast.blocks.length, 10);
  assert.deepEqual(
    cast.blocks.map((block) => block.huddleChannel),
    ["standup", ...range(2, 11).map((n) => `standup-${n}`)],
  );
  const placed = [
    ...cast.watchers,
    ...cast.listeners,
    ...cast.blocks.flatMap((b) => [
      ...b.talkers,
      ...b.reactors,
      b.uploader,
      ...b.roamers,
      b.visitor,
      ...b.huddle,
      b.reader,
    ]),
  ].sort((a, b) => a - b);
  assert.deepEqual(placed, range(0, 200));
});

test("fewer than 18 people cannot fill the first block", () => {
  assert.throws(() => soakCast(17), /at least 18/);
});
