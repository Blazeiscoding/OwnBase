import { describe, expect, it } from "vitest";
import {
  changeSavedServers,
  isSignInChange,
  readSavedServers,
  type SignInChange,
} from "../src/lib/savedServers.js";
import type { SavedServer } from "../src/platform.js";

const signIn = (port: number, workspaceName: string, token = `${port}-not-a-credential`) =>
  ({
    url: `http://192.168.1.20:${port}`,
    token,
    workspaceName,
    handle: "sam",
    lastUsedAt: 0,
  }) satisfies SavedServer;
const rocket = signIn(8543, "Rocket Team");
const design = signIn(8544, "Design Guild");

describe("one change to the saved sign-ins", () => {
  it("puts the one opened first, in place of an older sign-in to the same workspace", () => {
    const renewed = { ...design, token: "renewed-not-a-credential", lastUsedAt: 5 };
    expect(
      changeSavedServers([rocket, design], { kind: "use", server: renewed, held: false }),
    ).toEqual([renewed, rocket]);
  });

  it("does not bring back one this window held after another window forgot it", () => {
    const use: SignInChange = { kind: "use", server: { ...design, lastUsedAt: 9 }, held: true };
    expect(changeSavedServers([rocket], use)).toEqual([rocket]);
    // Still there, it moves to the front as any other.
    expect(changeSavedServers([rocket, design], use)).toEqual([
      { ...design, lastUsedAt: 9 },
      rocket,
    ]);
  });

  it("forgets a workspace, and signs out of one sign-in but not a newer one", () => {
    expect(changeSavedServers([rocket, design], { kind: "forget", url: design.url })).toEqual([
      rocket,
    ]);
    const renewed = { ...design, token: "renewed-not-a-credential" };
    const signOut: SignInChange = { kind: "signOut", url: design.url, token: design.token };
    expect(changeSavedServers([rocket, renewed], signOut)).toEqual([rocket, renewed]);
    expect(changeSavedServers([rocket, design], signOut)).toEqual([rocket]);
  });

  it("is only what it says, as data a store can write down", () => {
    expect(isSignInChange({ kind: "use", server: rocket, held: false })).toBe(true);
    expect(isSignInChange({ kind: "forget", url: rocket.url })).toBe(true);
    expect(isSignInChange({ kind: "signOut", url: rocket.url, token: rocket.token })).toBe(true);
    expect(isSignInChange({ kind: "use", server: { ...rocket, token: "" }, held: false })).toBe(
      false,
    );
    expect(isSignInChange({ kind: "use", server: rocket })).toBe(false);
    expect(isSignInChange({ kind: "signOut", url: rocket.url })).toBe(false);
    expect(isSignInChange({ kind: "clear" })).toBe(false);
    expect(isSignInChange(null)).toBe(false);
  });

  it("reads none as an empty list, and what is not a list of sign-ins as null", () => {
    expect(readSavedServers(null)).toEqual([]);
    expect(readSavedServers([rocket])).toEqual([rocket]);
    expect(readSavedServers("not a list")).toBeNull();
    expect(readSavedServers([{ ...rocket, url: "ftp://192.168.1.20" }])).toBeNull();
  });
});
