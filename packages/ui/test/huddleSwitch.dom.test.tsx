import { describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel } from "@ownbase/protocol";
import { confirmHuddleSwitch } from "../src/components/HuddleButton.js";

const room = (id: string, name: string): Channel => ({
  id,
  type: "public",
  name,
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
  memberIds: [],
});

function inHuddle(channelId: string | null, sharingScreen = false) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    channels: { C_DESIGN: room("C_DESIGN", "design"), C_ENG: room("C_ENG", "engineering") },
    huddle: channelId ? ({ channelId, sharingScreen } as never) : null,
  });
  return client;
}

describe("joining a huddle while in another", () => {
  it("asks first, naming the one left, and what is shared there", async () => {
    const ask = vi.fn().mockResolvedValue(false);
    expect(await confirmHuddleSwitch(inHuddle("C_DESIGN", true), ask, "C_ENG")).toBe(false);
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Switch huddles?",
        body: "You leave the huddle in #design, and stop sharing your screen there.",
      }),
    );
  });

  it("goes ahead without asking when not in one, or already in this one", async () => {
    const ask = vi.fn();
    expect(await confirmHuddleSwitch(inHuddle(null), ask, "C_ENG")).toBe(true);
    expect(await confirmHuddleSwitch(inHuddle("C_ENG"), ask, "C_ENG")).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});
