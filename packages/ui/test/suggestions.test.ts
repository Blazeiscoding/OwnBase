import type { Channel, User } from "@ownbase/protocol";
import { describe, expect, it } from "vitest";
import { customStartingWith, rankChannels, rankPeople } from "../src/components/Suggestions.js";

const person = (id: string, handle: string, displayName: string, deactivated = false) =>
  ({ id, handle, displayName, deactivated }) as unknown as User;
const channel = (id: string, name: string, extra: Partial<Channel> = {}) =>
  ({ id, name, type: "public", archived: false, ...extra }) as unknown as Channel;

describe("people offered after @", () => {
  const lisa = person("U_LISA", "lisa", "Lisa Samuels");
  const sam = person("U_SAM", "sam", "Sam Rivera");
  const isa = person("U_ISA", "isa", "Isabel Sanchez");
  const gone = person("U_GONE", "sammy", "Sammy Old", true);

  it("come by how well the name matches, not by when they joined", () => {
    // A handle or name starting with it, then a word starting with it.
    expect(rankPeople([lisa, isa, sam, gone], "sa", undefined).map((u) => u.handle)).toEqual([
      "sam",
      "isa",
      "lisa",
    ]);
  });

  it("put yourself after others who match as well", () => {
    expect(rankPeople([sam, isa], "", "U_ISA").map((u) => u.handle)).toEqual(["sam", "isa"]);
  });
});

describe("channels offered after #", () => {
  const design = channel("C1", "design");
  const review = channel("C2", "design-review");
  const ux = channel("C3", "ux-design");
  const old = channel("C4", "design-old", { archived: true });
  const dm = channel("D1", "design", { type: "dm" });

  it("leave out DMs and archived channels, and put joined ones first among equals", () => {
    const joined = (id: string) => id === "C3" || id === "C1";
    expect(rankChannels([ux, review, design, old, dm], "des", joined).map((c) => c.id)).toEqual([
      "C1",
      "C2",
      "C3",
    ]);
    expect(rankChannels([review, ux], "", joined).map((c) => c.id)).toEqual(["C3", "C2"]);
  });
});

describe("the workspace's own emoji offered after : (J12)", () => {
  const emoji = (name: string) => ({ id: `E_${name}`, name, createdBy: "U1" });
  const custom = Object.fromEntries(
    ["party-parrot", "parrot-wave", "ship_it", "pancake"].map((name) => [name, emoji(name)]),
  );

  it("come when their name or a word of it starts with what was typed, whole names first", () => {
    expect(customStartingWith(custom, "pa").map((e) => e.name)).toEqual([
      "pancake",
      "parrot-wave",
      "party-parrot",
    ]);
    expect(customStartingWith(custom, "parrot").map((e) => e.name)).toEqual([
      "parrot-wave",
      "party-parrot",
    ]);
    expect(customStartingWith(custom, "it").map((e) => e.name)).toEqual(["ship_it"]);
    expect(customStartingWith(custom, "zz")).toEqual([]);
  });
});
