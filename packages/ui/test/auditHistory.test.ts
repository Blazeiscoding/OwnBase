import { describe, expect, it } from "vitest";
import type { AuditAction, AuditEntry, ID, User } from "@ownbase/protocol";
import { describeAuditEntry } from "../src/components/AuditHistory.js";

const person = (id: ID, displayName: string): User => ({
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

const users: Record<ID, User> = {
  A: person("A", "Alice"),
  B: person("B", "Bob"),
  J: person("J", "James"),
};

const entry = (action: AuditAction, overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  id: "E1",
  at: 0,
  actorId: "A",
  action,
  targetType: "user",
  targetId: "B",
  details: {},
  ...overrides,
});

const say = (e: AuditEntry, selfId?: ID) => describeAuditEntry(e, users, selfId);

describe("an entry, as an administrator would say it", () => {
  it("names who did it and to whom", () => {
    expect(say(entry("user.deactivated"))).toBe("Alice deactivated Bob");
    expect(say(entry("user.role_changed", { details: { from: "member", to: "admin" } }))).toBe(
      "Alice changed Bob's role from member to admin",
    );
  });

  it("calls the person reading it 'you'", () => {
    expect(say(entry("user.reactivated"), "A")).toBe("You reactivated Bob");
    expect(say(entry("user.password_reset", { actorId: "B", targetId: "A" }), "A")).toBe(
      "Bob reset your password",
    );
  });

  it("attributes a command-line recovery to the host, since nobody was signed in", () => {
    expect(say(entry("account.recovered", { actorId: null, details: { madeOwner: true } }))).toBe(
      "The host recovered Bob's account from the server's command line and made them the owner",
    );
  });

  it("says an app's name, and never more of a URL than its host", () => {
    expect(
      say(entry("app.token_replaced", { targetType: "app", details: { name: "Deploy Bot" } })),
    ).toBe("Alice replaced Deploy Bot's bot token");
    expect(
      say(
        entry("command.created", {
          targetType: "command",
          details: { name: "Deploy Bot", command: "/deploy", host: "ci.internal:8080" },
        }),
      ),
    ).toBe("Alice added /deploy to Deploy Bot, calling ci.internal:8080");
    expect(
      say(
        entry("app.scopes_changed", {
          targetType: "app",
          details: { name: "Deploy Bot", added: "channels:history", removed: "chat:write.public" },
        }),
      ),
    ).toBe(
      "Alice changed what Deploy Bot may do: allowed channels:history; took away chat:write.public",
    );
  });

  it("gets a possessive right for a name ending in s", () => {
    expect(say(entry("user.password_reset", { targetId: "J" }))).toBe(
      "Alice reset James' password",
    );
  });

  it("still reads when the person has since gone from the list", () => {
    expect(say(entry("user.deactivated", { actorId: "GONE", targetId: "ALSO_GONE" }))).toBe(
      "Someone deactivated an account",
    );
  });

  it("says what the workspace was renamed to, and who may join it now", () => {
    expect(
      say(entry("workspace.renamed", { details: { from: "Rocket Team", to: "Blue Team" } })),
    ).toBe("Alice renamed the workspace from Rocket Team to Blue Team");
    expect(
      say(
        entry("workspace.access_policy_changed", {
          actorId: null,
          details: { from: "account_required", to: "guest_allowed" },
        }),
      ),
    ).toBe("The host changed who can join to anyone, guests included");
    expect(say(entry("workspace.access_policy_changed", { details: { to: "everyone" } }))).toBe(
      "Alice changed who can join",
    );
  });

  it("says whether the workspace's icon was changed or removed", () => {
    expect(
      say(
        entry("workspace.icon_changed", {
          details: { change: "set", type: "image/webp", bytes: 9000 },
        }),
      ),
    ).toBe("Alice changed the workspace's icon");
    expect(
      say(entry("workspace.icon_changed", { actorId: null, details: { change: "removed" } })),
    ).toBe("The host removed the workspace's icon");
  });

  it("says who made and downloaded a copy of the workspace", () => {
    const copy = { targetType: "workspace" as const, targetId: null };
    expect(say(entry("workspace.copy_made", copy))).toBe(
      "Alice made a copy of the workspace to download",
    );
    expect(say(entry("workspace.copy_downloaded", { ...copy, details: { bytes: 9 } }), "A")).toBe(
      "You downloaded a copy of the workspace",
    );
  });

  it("says what was done about a reported message, and how many reported it", () => {
    expect(say(entry("report.resolved", { details: { resolution: "dismiss", reports: 1 } }))).toBe(
      "Alice dismissed a report about Bob's message",
    );
    expect(
      say(entry("report.resolved", { details: { resolution: "deactivate", reports: 3 } })),
    ).toBe("Alice removed Bob's message after 3 reports");
  });

  it("has a sentence for every action the server records", () => {
    const actions: AuditAction[] = [
      "user.role_changed",
      "user.deactivated",
      "user.reactivated",
      "user.password_reset",
      "user.two_step_reset",
      "report.resolved",
      "user.invite_permission_granted",
      "user.invite_permission_removed",
      "account.recovered",
      "workspace.ownership_transferred",
      "workspace.renamed",
      "workspace.access_policy_changed",
      "workspace.icon_changed",
      "workspace.link_previews_changed",
      "workspace.copy_made",
      "workspace.copy_downloaded",
      "app.created",
      "app.deleted",
      "app.token_replaced",
      "app.signing_secret_replaced",
      "app.interactivity_url_changed",
      "app.scopes_changed",
      "webhook.created",
      "webhook.url_replaced",
      "webhook.deleted",
      "command.created",
      "command.deleted",
      "subscription.created",
      "subscription.retried",
      "subscription.deleted",
      "invite.created",
      "invite.revoked",
    ];
    for (const action of actions) {
      // With every detail an entry can carry, and with none: an entry from a
      // newer server, or missing a field, reads shorter rather than broken.
      const full = {
        name: "Bot",
        host: "ci.internal",
        retried: 2,
        from: "member",
        to: "admin",
        command: "/deploy",
      };
      for (const details of [full, {}]) {
        const sentence = say(entry(action, { details }));
        expect(sentence, action).toMatch(/^[A-Z]/);
        expect(sentence, action).not.toMatch(/undefined|null|\[object/);
      }
    }
  });
});
