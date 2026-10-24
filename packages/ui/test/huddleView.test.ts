import { describe, expect, it } from "vitest";
import type { User } from "@slackoss/protocol";
import { bigCallLine, CALL_HOLDS, huddleNames } from "../src/lib/huddleView.js";

const person = (id: string, displayName: string) => ({ id, displayName }) as User;

describe("naming who is in a huddle", () => {
  it("puts you first, and names someone it does not know yet", () => {
    const users = {
      U_SAM: person("U_SAM", "Sam Rivera"),
      U_PRIYA: person("U_PRIYA", "Priya Shah"),
    };
    expect(huddleNames(["U_PRIYA", "U_SAM", "U_NEW"], users, "U_SAM")).toEqual([
      "you",
      "Priya Shah",
      "someone",
    ]);
    expect(huddleNames(["U_PRIYA"], users, "U_SAM")).toEqual(["Priya Shah"]);
  });
});

describe("a call bigger than it was measured to hold (E13)", () => {
  it("says nothing up to six, and how to help past it", () => {
    expect(CALL_HOLDS).toBe(6);
    for (const people of [1, 2, 6]) expect(bigCallLine(people)).toBeNull();
    expect(bigCallLine(7)).toBe(
      "Calls of more than 6 people can stutter. Turning cameras off helps.",
    );
  });
});
