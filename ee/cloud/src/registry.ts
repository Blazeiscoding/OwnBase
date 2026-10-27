import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

/** A hosted workspace's plan, and what the server is told it includes. */
export const PLANS = {
  team: { name: "Team", members: 50, storageMb: 25_600 },
  business: { name: "Business", members: 200, storageMb: 102_400 },
} as const;
export type Plan = keyof typeof PLANS;

export type WorkspaceState = "active" | "suspended" | "deleted";

/** One hosted workspace, as the control plane keeps it. */
export interface HostedWorkspace {
  /** Its subdomain, <slug>.<domain>, and its folder's name. */
  slug: string;
  name: string;
  ownerEmail: string;
  plan: Plan;
  state: WorkspaceState;
  /** The loopback port its server listens on; Caddy is the only way in. */
  port: number;
  /** The code that claims it until someone owns it, sent in the owner's link. */
  claimCode: string;
  createdAt: number;
  updatedAt: number;
}

/** Names a person could mistake for OwnBase's own, kept off workspaces. */
const RESERVED = new Set([
  "admin",
  "api",
  "app",
  "billing",
  "cloud",
  "control",
  "docs",
  "help",
  "mail",
  "ownbase",
  "status",
  "support",
  "www",
]);

/** Why `slug` cannot name a workspace, or null when it can. */
export function slugProblem(slug: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/.test(slug))
    return "A workspace's address is 3 to 32 lowercase letters, digits or hyphens, starting and ending with a letter or digit";
  if (slug.includes("--")) return "A workspace's address has no two hyphens together";
  if (RESERVED.has(slug)) return `"${slug}" is kept for OwnBase itself`;
  return null;
}

/** A claim code: long, random, and plain enough for a link. */
export const newClaimCode = () => randomBytes(24).toString("base64url");

interface Row {
  slug: string;
  name: string;
  owner_email: string;
  plan: string;
  state: string;
  port: number;
  claim_code: string;
  created_at: number;
  updated_at: number;
}

const fromRow = (row: Row): HostedWorkspace => ({
  slug: row.slug,
  name: row.name,
  ownerEmail: row.owner_email,
  plan: row.plan as Plan,
  state: row.state as WorkspaceState,
  port: row.port,
  claimCode: row.claim_code,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * The workspaces this control plane hosts, in SQLite (node:sqlite, so no
 * native dependency). A deleted workspace keeps its row, so its address is
 * never handed to someone else; its port is free again.
 */
export class Registry {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS workspaces (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_email TEXT NOT NULL,
        plan TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'suspended', 'deleted')),
        port INTEGER NOT NULL,
        claim_code TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS workspaces_live_port
        ON workspaces (port) WHERE state != 'deleted';
    `);
  }

  list(): HostedWorkspace[] {
    return (
      this.db.prepare("SELECT * FROM workspaces ORDER BY slug").all() as unknown as Row[]
    ).map(fromRow);
  }

  get(slug: string): HostedWorkspace | null {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE slug = ?").get(slug) as
      Row | undefined;
    return row ? fromRow(row) : null;
  }

  /** Ports taken by workspaces not deleted. */
  portsInUse(): Set<number> {
    const rows = this.db
      .prepare("SELECT port FROM workspaces WHERE state != 'deleted'")
      .all() as unknown as { port: number }[];
    return new Set(rows.map((row) => row.port));
  }

  add(
    workspace: Omit<HostedWorkspace, "createdAt" | "updatedAt">,
    at = Date.now(),
  ): HostedWorkspace {
    this.db
      .prepare(
        `INSERT INTO workspaces (slug, name, owner_email, plan, state, port, claim_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspace.slug,
        workspace.name,
        workspace.ownerEmail,
        workspace.plan,
        workspace.state,
        workspace.port,
        workspace.claimCode,
        at,
        at,
      );
    return this.get(workspace.slug)!;
  }

  setState(slug: string, state: WorkspaceState, at = Date.now()): HostedWorkspace {
    this.db
      .prepare("UPDATE workspaces SET state = ?, updated_at = ? WHERE slug = ?")
      .run(state, at, slug);
    return this.get(slug)!;
  }

  /** Takes a workspace that never started back out, as if it was never asked for. */
  forget(slug: string): void {
    this.db.prepare("DELETE FROM workspaces WHERE slug = ?").run(slug);
  }

  close(): void {
    this.db.close();
  }
}
