import { describe, expect, it } from "vitest";
import { captureFailure } from "../src/capture.js";

/**
 * What someone is told when a huddle cannot reach their microphone, camera
 * or screen (CALL-01): nothing when they chose not to share, and otherwise
 * what to do about it rather than the browser's own words.
 */
const failure = (name: string, message = "") => new DOMException(message, name);

describe("a screen share that did not start", () => {
  it("says nothing when the picker was closed", () => {
    // Chromium, Electron's own picker and Firefox all call a closed picker this.
    expect(captureFailure("screen", failure("NotAllowedError", "Permission denied"))).toBeNull();
    expect(
      captureFailure(
        "screen",
        failure(
          "NotAllowedError",
          "The request is not allowed by the user agent or the platform in the current context.",
        ),
      ),
    ).toBeNull();
  });

  it("says where to allow it when the operating system refused", () => {
    expect(
      captureFailure("screen", failure("NotAllowedError", "Permission denied by system")),
    ).toBe(
      "Your system blocked screen sharing. Allow screen recording for this app in your system's privacy settings, then try again.",
    );
  });

  it("tells an insecure page from a browser that cannot share at all", () => {
    expect(captureFailure("screen", failure("NotSupportedError"), false)).toBe(
      "Screen sharing needs the desktop app, or a workspace address that starts with https://.",
    );
    expect(captureFailure("screen", failure("NotSupportedError"), true)).toBe(
      "This browser cannot share a screen.",
    );
  });

  it("asks for another try when capture itself failed", () => {
    expect(captureFailure("screen", failure("NotReadableError"))).toBe(
      "Screen sharing could not start. Try again.",
    );
    expect(captureFailure("screen", new Error("something else"))).toBe(
      "Screen sharing could not start. Try again.",
    );
  });
});

describe("a camera that did not start", () => {
  it("says it is blocked, and where to allow it", () => {
    expect(captureFailure("camera", failure("NotAllowedError", "Permission denied"))).toBe(
      "Camera access is blocked. Allow it in your browser or system settings, then try again.",
    );
  });

  it("says nothing when the prompt was closed", () => {
    expect(captureFailure("camera", failure("NotAllowedError", "Permission dismissed"))).toBeNull();
  });

  it("tells a missing camera from one another app holds", () => {
    expect(captureFailure("camera", failure("NotFoundError"))).toBe(
      "No camera was found. Connect one, then try again.",
    );
    expect(
      captureFailure("camera", failure("NotReadableError", "Could not start video source")),
    ).toBe(
      "Your camera could not start. Another app may be using it. Close that app, then try again.",
    );
  });

  it("names the page as the reason where it cannot ask", () => {
    expect(captureFailure("camera", failure("NotSupportedError"), false)).toBe(
      "Camera access needs the desktop app, or a workspace address that starts with https://.",
    );
  });
});

describe("a microphone that did not start", () => {
  it("is always explained, since a huddle cannot be joined without one", () => {
    expect(captureFailure("microphone", failure("NotAllowedError", "Permission dismissed"))).toBe(
      "Joining a huddle needs your microphone, and access to it is blocked. Allow it in your browser or system settings, then try again.",
    );
    expect(captureFailure("microphone", failure("NotFoundError"))).toBe(
      "No microphone was found. Connect one, then try again.",
    );
    expect(captureFailure("microphone", failure("NotSupportedError"), false)).toBe(
      "Microphone access needs the desktop app, or a workspace address that starts with https://.",
    );
  });
});
