import { describe, expect, it } from "vitest";
import type { AuditAction, AuditEntry, ID, User } from "@slackoss/protocol";
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

  it("has a sentence for every action the server records", () => {
    const actions: AuditAction[] = [
      "user.role_changed",
      "user.deactivated",
      "user.reactivated",
      "user.password_reset",
      "user.invite_permission_granted",
      "user.invite_permission_removed",
      "account.recovered",
      "workspace.ownership_transferred",
      "workspace.renamed",
      "workspace.access_policy_changed",
      "app.created",
      "app.deleted",
      "app.token_replaced",
      "app.signing_secret_replaced",
      "app.interactivity_url_changed",
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
