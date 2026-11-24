import { describe, expect, it } from "vitest";
import { messageReferences } from "../src/lib/messageReferences.js";

describe("what a message row looks up", () => {
  it("includes the channels it links, as well as those it names", () => {
    const { channelIds } = messageReferences({
      userId: "U1",
      text: "In <#C_NAMED>, see http://h.example/#/c/C_LINKED and http://h.example/#/c/C_MSG/m/M1.",
      reactions: [],
    });
    // A linked channel is read by its name, so a rename has to reach the row.
    expect(channelIds.sort()).toEqual(["C_LINKED", "C_MSG", "C_NAMED"]);
  });
});
