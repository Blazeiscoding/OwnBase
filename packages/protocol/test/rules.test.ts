import { describe, expect, it } from "vitest";
import {
  errorCodeOf,
  isAdministrator,
  isDirect,
  isRoom,
  roleMayCall,
  userMentionsIn,
} from "../src/index.js";

describe("shared rules", () => {
  it("counts owners and admins as running the workspace, and nobody else", () => {
    const roles = ["owner", "admin", "member", "guest", undefined] as const;
    expect(roles.map((role) => isAdministrator(role))).toEqual([true, true, false, false, false]);
  });

  it("lets each role call the routes its access names, and nobody signed out but public ones", () => {
    const roles = ["owner", "admin", "member", "guest", undefined] as const;
    const table = (["public", "guest", "member", "admin", "owner", "bot"] as const).map((access) =>
      roles.map((role) => roleMayCall(access, role)),
    );
    expect(table).toEqual([
      [true, true, true, true, true],
      [true, true, true, true, false],
      [true, true, true, false, false],
      [true, true, false, false, false],
      [true, false, false, false, false],
      [false, false, false, false, false],
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
