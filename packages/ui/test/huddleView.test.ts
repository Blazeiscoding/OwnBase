import { describe, expect, it } from "vitest";
import type { User } from "@slackoss/protocol";
import { bigCallLine, CALL_HOLDS, CAMERAS_HOLD, huddleNames } from "../src/lib/huddleView.js";

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

describe("a call bigger than it was measured to hold (E13, E13b)", () => {
  it("counts the cameras first, then the people, and says what helps", () => {
    expect([CAMERAS_HOLD, CALL_HOLDS]).toEqual([8, 16]);
    const holding: [people: number, cameras: number][] = [
      [2, 2],
      [12, 2],
      [12, 8],
      [16, 0],
    ];
    for (const [people, cameras] of holding) expect(bigCallLine(people, cameras)).toBeNull();
    expect(bigCallLine(9, 9)).toBe(
      "With more than 8 cameras on, the call can stutter. Turning cameras off helps.",
    );
    expect(bigCallLine(17, 1)).toBe(
      "Calls of more than 16 people can stutter. Muting when you're not talking helps.",
    );
    // Both: the cameras are what to turn off first.
    expect(bigCallLine(20, 10)).toMatch(/^With more than 8 cameras on/);
  });
});
