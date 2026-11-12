import { describe, expect, it, vi } from "vitest";
import { capabilitiesArgument, readCapabilities } from "../src/shared/bridge.js";
import { toFailure } from "../src/shared/desktopError.js";
import { lookup } from "../src/main/lookup.js";
import { RegistryFormatError } from "../src/main/registry.js";

describe("what the main process decided, handed to the window", () => {
  it("arrives as it was sent, among the window's other arguments", () => {
    const sent = {
      readerLocale: "en-IN",
      screenSound: true,
      systemMicrophone: false,
      openAtLogin: true,
    };
    expect(readCapabilities(["--type=renderer", capabilitiesArgument(sent), "--x"])).toEqual(sent);
  });

  it("is nothing where it is missing or cannot be read", () => {
    const none = {
      readerLocale: null,
      screenSound: false,
      systemMicrophone: false,
      openAtLogin: false,
    };
    expect(readCapabilities([])).toEqual(none);
    expect(readCapabilities(["--ownbase-capabilities={damaged"])).toEqual(none);
    expect(
      readCapabilities(['--ownbase-capabilities={"screenSound":"yes","readerLocale":7}']),
    ).toEqual(none);
  });
});

describe("a failure crossing the bridge", () => {
  it("names a list it cannot use by a code the window acts on, and says why in words", () => {
    expect(toFailure(new RegistryFormatError("newer"))).toEqual({
      code: "registry-unreadable",
      message: expect.stringMatching(/newer version of OwnBase .* Update OwnBase/),
    });
    expect(toFailure(new RegistryFormatError("unsupported"))).toEqual({
      code: "registry-unreadable",
      message: expect.stringMatching(/cannot read the list .* Use the version that saved it/),
    });
    expect(toFailure(new RegistryFormatError("invalid"))).toEqual({
      code: "registry-unreadable",
      message: expect.stringMatching(/is damaged\. Restore the settings file/),
    });
  });

  it("is failed, with its words, when nothing named it", () => {
    expect(toFailure(new Error("The folder could not be opened."))).toEqual({
      code: "failed",
      message: "The folder could not be opened.",
    });
    expect(toFailure("gone")).toEqual({ code: "failed", message: "gone" });
  });
});

describe("something looked up outside the app", () => {
  it("is read again once its time is up, or at once when forgotten", () => {
    let now = 0;
    const read = vi.fn(() => now);
    const kept = lookup(read, 5_000, () => now);
    expect(kept.get()).toBe(0);
    now = 4_000;
    expect(kept.get()).toBe(0);
    now = 6_000;
    expect(kept.get()).toBe(6_000);
    now = 7_000;
    kept.forget();
    expect(kept.get()).toBe(7_000);
    expect(read).toHaveBeenCalledTimes(3);
  });
});
