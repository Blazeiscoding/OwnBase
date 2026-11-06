import { describe, expect, it } from "vitest";
import { errorCodeOf, isAdministrator, isDirect, isRoom, userMentionsIn } from "../src/index.js";

describe("shared rules", () => {
  it("counts owners and admins as running the workspace, and nobody else", () => {
    expect(["owner", "admin", "member", "guest", undefined].map(isAdministrator)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it("tells rooms from direct messages, and a missing conversation from both", () => {
    expect(isRoom("private") && isDirect("group_dm")).toBe(true);
    expect(isRoom("dm") || isDirect("public")).toBe(false);
    expect(isRoom(undefined) || isDirect(undefined)).toBe(false);
  });

  it("reads the people a message names once each, ignoring look-alikes", () => {
    expect([...userMentionsIn("<@U1> and <@U2>, <@U1> again, <@not one> or <!here>")]).toEqual([
      "U1",
      "U2",
    ]);
  });

  it("keeps a code it knows and turns any other into http_error", () => {
    expect(errorCodeOf("channel_archived")).toBe("channel_archived");
    expect(errorCodeOf("FST_ERR_CTP_BODY_TOO_LARGE")).toBe("http_error");
    expect(errorCodeOf(undefined)).toBe("http_error");
  });
});
