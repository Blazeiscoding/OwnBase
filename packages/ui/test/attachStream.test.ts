import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachStream } from "../src/lib/attachStream.js";

/** A received camera track: muted until the first frames arrive, as in every browser. */
class FakeTrack extends EventTarget {
  kind = "video";
  readyState: MediaStreamTrackState = "live";
  constructor(public muted: boolean) {
    super();
  }
  unmute() {
    this.muted = false;
    this.dispatchEvent(new Event("unmute"));
  }
}

function fakes(muted = true) {
  const track = new FakeTrack(muted);
  const stream = { getVideoTracks: () => [track] } as unknown as MediaStream;
  const given: (MediaStream | null)[] = [];
  const element = {
    readyState: 0,
    play: vi.fn(() => Promise.resolve()),
    set srcObject(value: MediaStream | null) {
      given.push(value);
    },
  };
  return { track, stream, given, element: element as unknown as HTMLVideoElement & typeof element };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("playing a stream in a video element", () => {
  it("gives the element the stream and plays it", () => {
    const { stream, given, element } = fakes();
    attachStream(element, stream);
    expect(given).toEqual([stream]);
    expect(element.play).toHaveBeenCalledOnce();
  });

  it("gives it again when frames began but the element still has nothing (WebKit, J18)", () => {
    const { track, stream, given, element } = fakes();
    attachStream(element, stream);
    track.unmute();
    vi.advanceTimersByTime(1000);
    expect(given).toEqual([stream, null, stream]);
    expect(element.play).toHaveBeenCalledTimes(2);
  });

  it("leaves an element alone once it has the picture", () => {
    const { track, stream, given, element } = fakes();
    attachStream(element, stream);
    track.unmute();
    element.readyState = 4;
    vi.advanceTimersByTime(5000);
    expect(given).toEqual([stream]);
  });

  it("checks a stream whose frames had begun before it was attached", () => {
    const { stream, given, element } = fakes(false);
    attachStream(element, stream);
    vi.advanceTimersByTime(1000);
    expect(given).toEqual([stream, null, stream]);
  });

  it("does not keep trying for a camera that sends nothing", () => {
    const { track, stream, given, element } = fakes();
    attachStream(element, stream);
    vi.advanceTimersByTime(10_000);
    expect(given).toEqual([stream]);
    // Three tries at most, however long the element stays empty.
    track.unmute();
    vi.advanceTimersByTime(60_000);
    expect(given.filter((s) => s === null)).toHaveLength(3);
  });

  it("stops listening and lets go of the stream when detached", () => {
    const { track, stream, given, element } = fakes();
    const detach = attachStream(element, stream);
    track.unmute();
    detach();
    vi.advanceTimersByTime(5000);
    expect(given).toEqual([stream, null]);
    track.unmute();
    vi.advanceTimersByTime(5000);
    expect(given).toEqual([stream, null]);
  });
});
