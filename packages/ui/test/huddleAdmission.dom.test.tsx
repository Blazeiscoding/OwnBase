import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "./render.js";
import { WorkspaceClient } from "@ownbase/client-core";
import { ClientContext, PlatformContext } from "../src/context.js";
import { webPlatform } from "../src/platform.js";
import { HuddleButton } from "../src/components/HuddleBar.js";

afterEach(() => vi.restoreAllMocks());

describe("huddle admission feedback", () => {
  it("announces a refused join and allows an explicit retry", async () => {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token");
    const join = vi
      .spyOn(client, "joinHuddle")
      .mockRejectedValueOnce(
        new Error("Huddle joins are temporarily limited. Wait 2 seconds, then try again."),
      )
      .mockResolvedValue(undefined);
    render(
      <PlatformContext.Provider value={webPlatform()}>
        <ClientContext.Provider value={client}>
          <HuddleButton channelId="C_GENERAL" />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const button = screen.getByRole("button", { name: "Start a huddle" });
    fireEvent.click(button);
    const refused = "Huddle joins are temporarily limited. Wait 2 seconds, then try again.";
    expect(await screen.findByText(refused)).toBeVisible();
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText(refused)).toBeNull());
    expect(join).toHaveBeenCalledTimes(2);
    client.destroy();
  });
});
