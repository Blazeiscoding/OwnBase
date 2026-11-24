import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import { render } from "./render.js";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { ClientContext } from "../src/context.js";
import { PartnerFace, PartnerStatus } from "../src/components/PartnerTime.js";

/**
 * A direct message's header says who it is with as Slack's does: their face,
 * whether they are here, and their status.
 */
const person = (id: string, displayName: string, extra: Partial<User> = {}): User => ({
  id,
  handle: displayName.toLowerCase(),
  displayName,
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
  ...extra,
});
const maya = person("U_MAYA", "Maya");
const sam = person("U_SAM", "Sam", { statusEmoji: "🌴", statusText: "On holiday until Monday" });
const priya = person("U_PRIYA", "Priya");
const conversation = (id: string, type: Channel["type"], memberIds: string[]): Channel =>
  ({
    id,
    type,
    name: "",
    topic: "",
    description: "",
    creatorId: maya.id,
    archived: false,
    createdAt: 0,
    memberIds,
  }) as Channel;
const dm = conversation("D_SAM", "dm", [maya.id, sam.id]);
const group = conversation("G_THREE", "group_dm", [maya.id, sam.id, priya.id]);

const clients: WorkspaceClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
});

function header(channelId: string) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "synthetic-test-token");
  clients.push(client);
  client.store.setState({
    self: maya,
    users: { [maya.id]: maya, [sam.id]: sam, [priya.id]: priya },
    channels: { [dm.id]: dm, [group.id]: group },
    presence: { [sam.id]: "away" },
  });
  render(
    <ClientContext.Provider value={client}>
      <div data-testid="header">
        <PartnerFace channelId={channelId} />
        <PartnerStatus channelId={channelId} />
      </div>
    </ClientContext.Provider>,
  );
  return client;
}

describe("a direct message's header", () => {
  it("shows the other person's face, whether they are here, and their status", () => {
    const client = header(dm.id);
    expect(screen.getByRole("img", { name: "Away" })).toBeInTheDocument();
    const status = screen.getByText("🌴 On holiday until Monday");
    // Cut short in a narrow header, the whole of it stays in the title.
    expect(status).toHaveAttribute("title", "🌴 On holiday until Monday");

    act(() => client.store.setState({ presence: { [sam.id]: "online" } }));
    expect(screen.getByRole("img", { name: "Active" })).toBeInTheDocument();
    act(() => client.store.setState({ presence: {} }));
    expect(screen.getByRole("img", { name: "Offline" })).toBeInTheDocument();

    // A status cleared elsewhere leaves the header with the name alone.
    act(() =>
      client.store.setState({
        users: { [maya.id]: maya, [sam.id]: { ...sam, statusEmoji: "", statusText: "" } },
      }),
    );
    expect(screen.queryByText(/On holiday/)).toBeNull();
  });

  it("adds nothing to a group conversation, which has no one person", () => {
    header(group.id);
    expect(screen.getByTestId("header")).toBeEmptyDOMElement();
  });
});
