import { ApiError, WorkspaceClient } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  APP_COMMANDS,
  appCommand,
  runAppCommand,
  withAppCommands,
} from "../src/lib/appCommands.js";

const person = (id: string, displayName: string) => ({ id, displayName }) as unknown as User;
const channel = (id: string, type: Channel["type"], name: string) =>
  ({ id, type, name, archived: false }) as unknown as Channel;

function workspace() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    users: { U_SAM: person("U_SAM", "Sam Rivera"), U_KAI: person("U_KAI", "Kai") },
    channels: { C1: channel("C1", "public", "design"), D1: channel("D1", "dm", "") },
  });
  return client;
}

describe("the commands the app runs", () => {
  const appTopic = { command: "topic", description: "", usageHint: "", builtin: false };

  it("are told apart from what goes to the server", () => {
    expect(appCommand("/away", [])).toEqual({ name: "away", args: "" });
    expect(appCommand("  /STATUS 🌴 On holiday ", [])).toEqual({
      name: "status",
      args: "🌴 On holiday",
    });
    expect(appCommand("/shrug hm", [])).toBeNull();
    expect(appCommand("away", [])).toBeNull();
    // An app's command of that name, kept from before they were reserved, still wins.
    expect(appCommand("/topic hi", [appTopic])).toBeNull();
  });

  it("are offered beside the server's, without the channel ones in a DM", () => {
    const names = (room: boolean) => withAppCommands([appTopic], room).map((c) => c.command);
    expect(names(true)).toEqual([
      "topic",
      ...APP_COMMANDS.map((c) => c.command).filter((c) => c !== "topic"),
    ]);
    expect(names(false)).not.toContain("invite");
    expect(names(false)).not.toContain("leave");
    expect(names(false)).toContain("mute");
  });

  it("set and clear a status, its emoji apart from its words", async () => {
    const client = workspace();
    const updateMe = vi
      .spyOn(client.api, "updateMe")
      .mockImplementation(
        async (body) => ({ user: { ...person("U_SAM", "Sam"), ...body } }) as never,
      );
    expect(await runAppCommand("status", "🌴 On holiday", { client, channelId: "C1" })).toEqual({
      ok: true,
      said: "Your status is now 🌴 On holiday.",
    });
    expect(updateMe).toHaveBeenLastCalledWith({
      statusEmoji: "🌴",
      statusText: "On holiday",
      statusExpiresAt: null,
    });
    await runAppCommand("status", "clear", { client, channelId: "C1" });
    expect(updateMe).toHaveBeenLastCalledWith({
      statusEmoji: "",
      statusText: "",
      statusExpiresAt: null,
    });
    expect((await runAppCommand("status", "", { client, channelId: "C1" })).ok).toBe(false);
  });

  it("add the people mentioned, and name who could not be added", async () => {
    const client = workspace();
    const invite = vi.spyOn(client.api, "inviteMember").mockImplementation(async (_c, id) => {
      if (id === "U_KAI") throw new ApiError(403, "admin_only");
      return { ok: true };
    });
    expect(
      await runAppCommand("invite", "<@U_SAM> and <@U_KAI> <@U_SAM>", { client, channelId: "C1" }),
    ).toEqual({ ok: false, said: "Added Sam Rivera. Could not add Kai to #design." });
    expect(invite).toHaveBeenCalledTimes(2);
    expect((await runAppCommand("invite", "Sam", { client, channelId: "C1" })).said).toMatch(
      /Mention the people/,
    );
  });

  it("set a topic, and say why when the server refuses", async () => {
    const client = workspace();
    const update = vi.spyOn(client.api, "updateChannel").mockResolvedValue({} as never);
    expect(await runAppCommand("topic", "Ship it", { client, channelId: "C1" })).toEqual({
      ok: true,
      said: "Topic of #design set.",
    });
    expect(update).toHaveBeenCalledWith("C1", { topic: "Ship it" });
    update.mockRejectedValue(new ApiError(403, "admin_only"));
    expect((await runAppCommand("topic", "Ship it", { client, channelId: "C1" })).said).toMatch(
      /Only someone who can manage #design/,
    );
  });

  it("keep channel commands out of a DM, but mute one", async () => {
    const client = workspace();
    const leave = vi.spyOn(client.api, "leaveChannel");
    expect(await runAppCommand("leave", "", { client, channelId: "D1" })).toEqual({
      ok: false,
      said: "/leave works in channels, not in direct messages.",
    });
    expect(leave).not.toHaveBeenCalled();
    const prefs = vi.spyOn(client, "setChannelPrefs").mockResolvedValue(null);
    expect(await runAppCommand("mute", "", { client, channelId: "D1" })).toEqual({
      ok: true,
      said: "This conversation is muted.",
    });
    expect(prefs).toHaveBeenCalledWith("D1", { muted: true });
  });

  it("show you away, and say so when that fails", async () => {
    const client = workspace();
    vi.spyOn(client, "setAway")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new ApiError(0, "network_error", "offline"));
    expect((await runAppCommand("away", "", { client, channelId: "C1" })).said).toBe(
      "You are shown as away.",
    );
    expect((await runAppCommand("active", "", { client, channelId: "C1" })).ok).toBe(false);
  });
});
