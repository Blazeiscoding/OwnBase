import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient, type HuddlePeer } from "@slackoss/client-core";
import type { User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { webPlatform, type Platform } from "../src/platform.js";
import { HuddleBar } from "../src/components/HuddleBar.js";
import { HuddleAudio } from "../src/components/HuddleAudio.js";

/** Where call preferences are kept, as in the app. */
const platform = webPlatform();

/**
 * Hearing the others in a huddle when the browser will not play sound until
 * someone asks (CALL-01). That used to be swallowed, leaving a huddle where
 * nobody could be heard and nothing said why; now the bar says so and asks.
 */
const person = (id: string, displayName: string): User => ({
  id,
  handle: displayName.toLowerCase(),
  displayName,
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});

const priya: HuddlePeer = {
  userId: "U_PRIYA",
  audioStream: {} as MediaStream,
  cameraStream: null,
  screenStream: null,
  connected: true,
  micMuted: false,
  speaking: false,
};

const spyPlay = () => vi.spyOn(HTMLMediaElement.prototype, "play");
let play: ReturnType<typeof spyPlay>;
beforeEach(() => {
  play = spyPlay();
});
afterEach(() => vi.restoreAllMocks());

function bar() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  const sam = person("U_SAM", "Sam");
  client.store.setState({
    self: sam,
    users: { U_SAM: sam, U_PRIYA: person("U_PRIYA", "Priya") },
    status: "online",
    huddle: {
      channelId: "C_GENERAL",
      micMuted: false,
      cameraOn: false,
      sharingScreen: false,
      localCameraStream: null,
      localScreenStream: null,
      speaking: false,
      micLost: false,
      peers: [priya],
    },
  });
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <HuddleBar />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  return client;
}

const refused = () => Promise.reject(new DOMException("play() needs a gesture", "NotAllowedError"));

describe("sound the browser holds back", () => {
  it("says so, and plays once Turn on sound is pressed", async () => {
    const user = userEvent.setup();
    play.mockImplementationOnce(refused).mockResolvedValue();
    bar();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your browser is holding back the huddle's sound.",
    );
    await user.click(screen.getByRole("button", { name: "Turn on sound" }));
    expect(play.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("plays on any key press too, for when the bar is out of sight", async () => {
    const user = userEvent.setup();
    play.mockImplementationOnce(refused).mockResolvedValue();
    bar();
    await screen.findByRole("alert");
    await user.keyboard("{Shift}");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps asking while the browser still refuses", async () => {
    const user = userEvent.setup();
    play.mockImplementation(refused);
    bar();
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Turn on sound" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("says nothing when the sound plays", async () => {
    play.mockResolvedValueOnce();
    bar();
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says nothing of a play cut short by the next stream", async () => {
    play.mockRejectedValueOnce(new DOMException("interrupted by a new load", "AbortError"));
    bar();
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stops asking once the person held back leaves", async () => {
    play.mockImplementation(refused);
    const client = bar();
    await screen.findByRole("alert");
    act(() => client.store.setState({ huddle: { ...client.state.huddle!, peers: [] } }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

const peer = (userId: string): HuddlePeer => ({
  userId,
  audioStream: {} as MediaStream,
  cameraStream: null,
  screenStream: null,
  connected: true,
  micMuted: false,
  speaking: false,
});

describe("recovering huddle audio", () => {
  it("offers one gesture to retry blocked peers and leaves audible peers playing", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new DOMException("Autoplay blocked", "NotAllowedError"))
      .mockRejectedValueOnce(new DOMException("Autoplay blocked", "NotAllowedError"))
      .mockResolvedValue(undefined);
    const peers = [peer("A"), peer("B"), peer("C")];
    const { container } = render(<HuddleAudio peers={peers} />);
    const retry = await screen.findByRole("button", { name: "Turn on sound" });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(play).toHaveBeenCalledTimes(3);
    fireEvent.click(retry);
    // These calls happen inside the click, before an effect or another task.
    expect(play).toHaveBeenCalledTimes(5);
    const audio = container.querySelectorAll("audio");
    expect(play.mock.contexts.slice(3)).toEqual([audio[0], audio[1]]);
    await waitFor(() => expect(screen.queryByRole("button")).not.toBeInTheDocument());
    expect(audio[2]!.srcObject).toBe(peers[2]!.audioStream);
  });

  it("keeps recovery available when another playback attempt fails", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValue(new Error("Device unavailable"));
    render(<HuddleAudio peers={[peer("A")]} />);
    const retry = await screen.findByRole("button", { name: "Turn on sound" });
    fireEvent.click(retry);
    await act(async () => {});
    expect(play).toHaveBeenCalledTimes(2);
    expect(retry).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Call audio could not start.");
  });

  it("ignores a removed peer's late rejection and detaches its stream", async () => {
    let reject!: (reason: Error) => void;
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    const { container, rerender } = render(<HuddleAudio peers={[peer("A")]} />);
    const audio = container.querySelector("audio")!;
    rerender(<HuddleAudio peers={[]} />);
    await act(async () => reject(new Error("Late failure")));
    expect(audio.srcObject).toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not let a superseded stream's failure block a working replacement", async () => {
    let reject!: (reason: Error) => void;
    vi.spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(undefined);
    const { rerender } = render(<HuddleAudio peers={[peer("A")]} />);
    rerender(<HuddleAudio peers={[peer("A")]} />);
    await act(async () => reject(new Error("Old stream failed")));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

/** An audio graph that only records what it was asked to do. */
class FakeContext {
  static made: FakeContext[] = [];
  state: AudioContextState = "running";
  currentTime = 0;
  source: MediaStream | null = null;
  out = { stream: { id: "boosted" } as unknown as MediaStream };
  amp = {
    gain: { setTargetAtTime: vi.fn() },
    connect: (next: unknown) => next,
  };
  close = vi.fn(async () => {});
  resume = vi.fn(() => Promise.resolve());
  constructor() {
    FakeContext.made.push(this);
  }
  createGain() {
    return this.amp;
  }
  createMediaStreamDestination() {
    return this.out;
  }
  createMediaStreamSource(stream: MediaStream) {
    this.source = stream;
    return { connect: (next: unknown) => next };
  }
}

describe("as loud as you chose each person to be", () => {
  beforeEach(() => {
    FakeContext.made = [];
    vi.stubGlobal("AudioContext", FakeContext);
    play.mockResolvedValue();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("turns someone down, or off, with the element's own volume", async () => {
    const a = peer("A");
    const { container, rerender } = render(
      <HuddleAudio peers={[a]} volumes={{ A: { volume: 40, muted: false } }} />,
    );
    const audio = container.querySelector("audio")!;
    expect(audio.volume).toBeCloseTo(0.4);
    expect(audio.srcObject).toBe(a.audioStream);
    rerender(<HuddleAudio peers={[a]} volumes={{ A: { volume: 40, muted: true } }} />);
    expect(audio.volume).toBe(0);
    // Nobody else is touched, and no audio graph is needed for any of it.
    rerender(<HuddleAudio peers={[a, peer("B")]} volumes={{ A: { volume: 40, muted: true } }} />);
    expect(container.querySelectorAll("audio")[1]!.volume).toBe(1);
    expect(FakeContext.made).toEqual([]);
  });

  it("turns someone up past how they arrive through a gain, holding their stream in a muted element", async () => {
    const a = peer("A");
    const { container, rerender } = render(
      <HuddleAudio peers={[a]} volumes={{ A: { volume: 150, muted: false } }} />,
    );
    await waitFor(() => expect(container.querySelectorAll("audio")).toHaveLength(2));
    const [audio, keeper] = container.querySelectorAll("audio");
    const graph = FakeContext.made[0]!;
    expect(graph.source).toBe(a.audioStream);
    expect(audio!.srcObject).toBe(graph.out.stream);
    expect(audio!.volume).toBe(1);
    expect(keeper!.muted).toBe(true);
    expect(keeper!.srcObject).toBe(a.audioStream);
    expect(graph.amp.gain.setTargetAtTime).toHaveBeenLastCalledWith(1.5, 0, expect.any(Number));

    rerender(<HuddleAudio peers={[a]} volumes={{ A: { volume: 200, muted: false } }} />);
    expect(graph.amp.gain.setTargetAtTime).toHaveBeenLastCalledWith(2, 0, expect.any(Number));
    expect(FakeContext.made).toHaveLength(1);

    // Back down: the element alone again, and the graph let go.
    rerender(<HuddleAudio peers={[a]} volumes={{ A: { volume: 80, muted: false } }} />);
    await waitFor(() => expect(container.querySelectorAll("audio")).toHaveLength(1));
    expect(graph.close).toHaveBeenCalled();
    expect(audio!.srcObject).toBe(a.audioStream);
    expect(audio!.volume).toBeCloseTo(0.8);
  });

  it("asks for a gesture when the graph will not start without one", async () => {
    class Stopped extends FakeContext {
      override state: AudioContextState = "suspended";
      override resume = vi.fn(() => new Promise<void>(() => {}));
    }
    vi.stubGlobal("AudioContext", Stopped);
    render(<HuddleAudio peers={[peer("A")]} volumes={{ A: { volume: 180, muted: false } }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your browser is holding back the huddle's sound.",
    );
  });
});

describe("each person's volume, from the bar", () => {
  function barOn() {
    const platform = {
      kind: "web",
      storage: { get: async () => null, set: async () => {} },
      notify: () => {},
    } as unknown as Platform;
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    const sam = person("U_SAM", "Sam");
    client.store.setState({
      self: sam,
      users: { U_SAM: sam, U_PRIYA: person("U_PRIYA", "Priya") },
      status: "online",
      huddle: {
        channelId: "C_GENERAL",
        micMuted: false,
        cameraOn: false,
        sharingScreen: false,
        localCameraStream: null,
        localScreenStream: null,
        speaking: false,
        micLost: false,
        peers: [priya],
      },
    });
    const utils = render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <HuddleBar />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    return { ...utils, user: userEvent.setup() };
  }

  it("is set for each of the others in the list of who is there, and muted for you alone", async () => {
    play.mockResolvedValue();
    const { container, user } = barOn();
    const audio = container.querySelector("audio")!;
    await user.click(screen.getByRole("button", { name: "Everyone in the huddle (2)" }));
    const list = screen.getByRole("list", { name: "In the huddle" });
    // Yours is not yours to set: only the others have a volume.
    expect(within(list).getAllByRole("slider")).toHaveLength(1);
    const volume = within(list).getByRole("slider", { name: "Priya's volume" });
    expect(volume).toHaveValue("100");
    expect(volume).toHaveAttribute("aria-valuetext", "100%");

    fireEvent.change(volume, { target: { value: "60" } });
    expect(volume).toHaveAttribute("aria-valuetext", "60%");
    expect(audio.volume).toBeCloseTo(0.6);

    const mute = within(list).getByRole("button", { name: "Mute Priya for you" });
    await user.click(mute);
    expect(mute).toHaveAttribute("aria-pressed", "true");
    expect(audio.volume).toBe(0);
    expect(within(list).getByRole("listitem", { name: "Priya, muted for you" })).toBeVisible();
    // Her volume is kept, and moving it is wanting to hear her again.
    expect(volume).toHaveValue("60");
    fireEvent.change(volume, { target: { value: "70" } });
    expect(mute).toHaveAttribute("aria-pressed", "false");
    expect(audio.volume).toBeCloseTo(0.7);
  });
});

describe("the sound of a shared screen", () => {
  const sharing = (userId: string): HuddlePeer => ({
    ...peer(userId),
    screenStream: {} as MediaStream,
    screenSoundStream: {} as MediaStream,
  });

  it("plays beside their voice, each at the volume you chose for it", () => {
    play.mockResolvedValue();
    const a = sharing("A");
    const { container, rerender } = render(
      <HuddleAudio
        peers={[a]}
        volumes={{ A: { volume: 40, muted: false }, "screen:A": { volume: 70, muted: false } }}
      />,
    );
    const [voice, sound] = container.querySelectorAll("audio");
    expect(voice!.srcObject).toBe(a.audioStream);
    expect(voice!.volume).toBeCloseTo(0.4);
    expect(sound!.srcObject).toBe(a.screenSoundStream);
    expect(sound!.volume).toBeCloseTo(0.7);

    // Muting the video leaves them heard, and the other way round.
    rerender(
      <HuddleAudio
        peers={[a]}
        volumes={{ A: { volume: 40, muted: false }, "screen:A": { volume: 70, muted: true } }}
      />,
    );
    expect(sound!.volume).toBe(0);
    expect(voice!.volume).toBeCloseTo(0.4);

    // A share without sound, or none, plays only the voice.
    rerender(<HuddleAudio peers={[{ ...a, screenSoundStream: null }]} />);
    expect(container.querySelectorAll("audio")).toHaveLength(1);
    expect(container.querySelector("audio")!.srcObject).toBe(a.audioStream);
  });

  it("is asked for with the voices when the browser holds sound back, and plays with them", async () => {
    const user = userEvent.setup();
    play.mockImplementationOnce(refused).mockImplementationOnce(refused).mockResolvedValue();
    render(<HuddleAudio peers={[sharing("A")]} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your browser is holding back the huddle's sound.",
    );
    await user.click(screen.getByRole("button", { name: "Turn on sound" }));
    // Both elements tried again from the one press.
    expect(play.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
