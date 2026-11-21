import { describe, expect, it } from "vitest";
import type { Role } from "../src/entities.js";
import {
  changePersonRefusal,
  mayAddEmoji,
  mayManageInvite,
  mayRemoveEmoji,
} from "../src/permissions.js";

const person = (id: string, role: Role) => ({ id, role });

describe("who may", () => {
  it("add emoji: any member, or only admins when the workspace says so; never a guest", () => {
    expect(mayAddEmoji("member", false)).toBe(true);
    expect(mayAddEmoji("member", true)).toBe(false);
    expect(mayAddEmoji("admin", true)).toBe(true);
    expect(mayAddEmoji("owner", true)).toBe(true);
    expect(mayAddEmoji("guest", false)).toBe(false);
    expect(mayAddEmoji(undefined, false)).toBe(false);
  });

  it("remove an emoji: whoever added it, or an admin", () => {
    const emoji = { createdBy: "U1" };
    expect(mayRemoveEmoji(person("U1", "member"), emoji)).toBe(true);
    expect(mayRemoveEmoji(person("U2", "member"), emoji)).toBe(false);
    expect(mayRemoveEmoji(person("U2", "admin"), emoji)).toBe(true);
    expect(mayRemoveEmoji(person("U1", "guest"), emoji)).toBe(false);
    expect(mayRemoveEmoji(null, emoji)).toBe(false);
  });

  it("see and revoke an invite code: whoever made it, or an admin", () => {
    const invite = { createdBy: "U1" };
    expect(mayManageInvite(person("U1", "member"), invite)).toBe(true);
    expect(mayManageInvite(person("U2", "member"), invite)).toBe(false);
    expect(mayManageInvite(person("U2", "owner"), invite)).toBe(true);
    expect(mayManageInvite(undefined, invite)).toBe(false);
  });

  it("change someone: not yourself, never the owner, another admin only as the owner", () => {
    const admin = person("A", "admin");
    expect(changePersonRefusal(admin, admin)).toBe("self");
    expect(changePersonRefusal(admin, person("O", "owner"))).toBe("owner");
    expect(changePersonRefusal(admin, person("B", "admin"))).toBe("admin");
    expect(changePersonRefusal(person("O", "owner"), person("B", "admin"))).toBeNull();
    expect(changePersonRefusal(admin, person("M", "member"))).toBeNull();
    expect(changePersonRefusal(admin, person("G", "guest"))).toBeNull();
  });
});
