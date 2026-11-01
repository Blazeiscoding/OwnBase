import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { webPlatform } from "../src/platform.js";
import { HuddleControls } from "../src/components/HuddleControls.js";

/** Where call preferences are kept, as in the app. */
const platform = webPlatform();

/**
 * The camera and screen buttons in a huddle (CALL-01). Closing the screen
 * picker says nothing; a blocked camera, a missing one or a refusal from the
 * operating system says what to do about it, where all of them used to be
 * swallowed alike.
 */
const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

function controls(overlay = false, micLost = false, talkingWhileMuted = false) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { U_SAM: sam },
    status: "online",
    huddle: {
      channelId: "C_GENERAL",
      micMuted: talkingWhileMuted,
      talkingWhileMuted,
      cameraOn: false,
      sharingScreen: false,
      localCameraStream: null,
      localScreenStream: null,
      speaking: false,
      micLost,
      peers: [],
    },
  });
  const camera = vi.spyOn(client, "toggleCamera");
  const share = vi.spyOn(client, "toggleScreenShare");
  const retryMic = vi.spyOn(client, "retryMicrophone").mockImplementation(() => {});
  const toggleMic = vi.spyOn(client, "toggleMic").mockImplementation(() => {});
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <HuddleControls overlay={overlay} />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  return { camera, share, retryMic, toggleMic };
}

const refused = (name: string, message: string) => new DOMException(message, name);

describe("turning on a camera or a screen share that does not start", () => {
  it("says the camera is blocked and where to allow it", async () => {
    const user = userEvent.setup();
    const { camera } = controls();
    camera.mockRejectedValueOnce(refused("NotAllowedError", "Permission denied"));
    await user.click(screen.getByRole("button", { name: "Camera" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Camera access is blocked. Allow it in your browser or system settings, then try again.",
    );
    // The buttons work again, for the try after allowing it.
    expect(screen.getByRole("button", { name: "Camera" })).toBeEnabled();
  });

  it("says nothing when the screen picker is closed", async () => {
    const user = userEvent.setup();
    const { share } = controls();
    share.mockRejectedValueOnce(refused("NotAllowedError", "Permission denied"));
    await user.click(screen.getByRole("button", { name: "Share screen" }));
    expect(share).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says where to allow screen recording when the system refused it", async () => {
    const user = userEvent.setup();
    const { share } = controls(true);
    share.mockRejectedValueOnce(refused("NotAllowedError", "Permission denied by system"));
    await user.click(screen.getByRole("button", { name: "Share screen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your system blocked screen sharing. Allow screen recording for this app in your system's privacy settings, then try again.",
    );
  });

  it("clears the message on Dismiss, and on the next try", async () => {
    const user = userEvent.setup();
    const { camera } = controls();
    camera.mockRejectedValueOnce(refused("NotFoundError", "Requested device not found"));
    await user.click(screen.getByRole("button", { name: "Camera" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No camera was found. Connect one, then try again.",
    );
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();

    camera.mockRejectedValueOnce(refused("NotReadableError", "Could not start video source"));
    await user.click(screen.getByRole("button", { name: "Camera" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Another app may be using it");
    camera.mockResolvedValueOnce();
    await user.click(screen.getByRole("button", { name: "Camera" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a microphone that stopped mid-call (CALL-01)", () => {
  it("says nobody can hear you, and asks for one again on Try again", async () => {
    const user = userEvent.setup();
    const { retryMic } = controls(false, true);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your microphone stopped, so nobody can hear you.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(retryMic).toHaveBeenCalledOnce();
  });

  it("says nothing while the microphone works", () => {
    controls();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("talking with the microphone off", () => {
  it("says nobody hears you, with Unmute and its shortcut", async () => {
    const user = userEvent.setup();
    const { toggleMic } = controls(false, false, true);
    const hint = screen.getByRole("status");
    expect(hint).toHaveTextContent("You're muted, so nobody hears you.");
    await user.click(screen.getByRole("button", { name: /^Unmute/ }));
    expect(toggleMic).toHaveBeenCalledOnce();
  });

  it("says nothing while not talking", () => {
    controls();
    expect(screen.queryByText(/nobody hears you/)).toBeNull();
  });
});
