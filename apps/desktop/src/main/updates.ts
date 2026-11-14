import type {
  RestartQuestion,
  UpdateMode,
  UpdateRestart,
  UpdateStatus,
} from "@ownbase/protocol/desktop";

export type { RestartQuestion };

export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;
/** How often it looks for a new version while one is not yet downloaded. */
export const CHECK_EVERY_MS = 4 * HOUR_MS;
/** Where the Mac app sends people for a new version. */
export const DOWNLOAD_PAGE = "https://ownbase.site";
/** What the main process keeps about updates, in its own settings. */
export const UPDATES_KEY = "updates";

/** The notice last shown in the window: for which version, and since when. */
export interface LastOffer {
  version: string;
  /** When it was first shown, or when it was last put off. */
  at: number;
  /** "Later" was pressed. */
  putOff: boolean;
}

/**
 * Whether to look for a new version now. Only a build the Release workflow
 * made looks at all. Asked by the person, it looks whatever the setting;
 * otherwise only with "Update automatically" on, at start and then every four
 * hours. With a release nearly every day, once one is downloaded it waits a
 * day before looking again, rather than download each one as it comes.
 */
export function checkDue(facts: {
  mode: UpdateMode;
  automatic: boolean;
  asked: boolean;
  checkedAt: number | null;
  ready: boolean;
  now: number;
}): boolean {
  if (facts.mode === "none") return false;
  if (facts.asked) return true;
  if (!facts.automatic) return false;
  if (facts.checkedAt === null) return true;
  return facts.now - facts.checkedAt >= (facts.ready ? DAY_MS : CHECK_EVERY_MS);
}

/**
 * Whether the window's notice shows. At most one new version is offered a
 * day: a version put off with "Later" comes back the next day, and a newer
 * one downloaded meanwhile waits for that day too.
 */
export function offerDue(facts: {
  newVersion: string | null;
  lastOffer: LastOffer | null;
  now: number;
}): boolean {
  const { newVersion, lastOffer, now } = facts;
  if (newVersion === null) return false;
  if (lastOffer === null) return true;
  if (lastOffer.version === newVersion && !lastOffer.putOff) return true;
  return now - lastOffer.at >= DAY_MS;
}

/** What hosting is doing, as far as a restart is concerned. */
export interface HostingNow {
  running: boolean;
  workspaceName?: string;
  /** The workspace starts again when OwnBase opens. */
  startsOnLaunch?: boolean;
}

export const IN_CALL =
  "You are in a call. Leave the call first, then restart to update. Otherwise the update installs the next time you quit OwnBase.";

/**
 * What "Restart to update" does now. Never during a call: it is refused, with
 * the reason. While a workspace is hosted here, it first says that the people
 * in it lose their connection.
 */
export function restartAnswer(facts: {
  inCall: boolean;
  hosting: HostingNow;
}):
  | { kind: "refuse"; reason: string }
  | { kind: "ask"; question: RestartQuestion }
  | { kind: "restart" } {
  if (facts.inCall) return { kind: "refuse", reason: IN_CALL };
  const { hosting } = facts;
  if (hosting.running) {
    const name = hosting.workspaceName ?? "the workspace you host";
    return {
      kind: "ask",
      question: {
        title: `Restart OwnBase and disconnect the people in ${name}?`,
        detail: hosting.startsOnLaunch
          ? `Everyone in ${name} is disconnected for a moment while OwnBase restarts. The workspace starts again with OwnBase.`
          : `Everyone in ${name} is disconnected until you start hosting it again after the restart.`,
        button: "Restart to update",
      },
    };
  }
  return { kind: "restart" };
}

/** `1.2.3-beta.4` as its parts, or null when it is not a version. */
function parseVersion(text: string): { core: number[]; pre: (number | string)[] } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4]
      ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
  };
}

/**
 * Orders two versions as semantic versioning does: 1.0.0-beta.2 before
 * 1.0.0-beta.10, and both before 1.0.0. Null when either is not a version.
 */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * Whether a copy running `current` may take `version`: only a newer one, and
 * a pre-release only for a copy that is itself one.
 */
export function isOffered(version: string, current: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  if (parsed.pre.length > 0 && (parseVersion(current)?.pre.length ?? 0) === 0) return false;
  return (compareVersions(version, current) ?? 0) > 0;
}

/** What is kept between runs. */
interface Kept {
  automatic: boolean;
  /** The version that ran last, so the first run of a new one can say what it replaced. */
  ranVersion: string | null;
  checkedAt: number | null;
  lastOffer: LastOffer | null;
}

export function readKept(value: unknown): Kept {
  const kept = (value ?? {}) as Record<string, unknown>;
  const offer = kept.lastOffer as Record<string, unknown> | null | undefined;
  return {
    automatic: kept.automatic !== false,
    ranVersion: typeof kept.ranVersion === "string" ? kept.ranVersion : null,
    checkedAt: typeof kept.checkedAt === "number" ? kept.checkedAt : null,
    lastOffer:
      offer && typeof offer.version === "string" && typeof offer.at === "number"
        ? { version: offer.version, at: offer.at, putOff: offer.putOff === true }
        : null,
  };
}

/** The Windows updater (electron-updater), as the controller uses it. */
export interface InstallFeed {
  /** The newer version the feed offers, or null when this one is the newest. */
  check: () => Promise<string | null>;
  /** Downloads what `check` found, in the background. */
  download: (progress: (percent: number) => void) => Promise<void>;
  /** Whether a downloaded version installs when OwnBase next quits. */
  installOnQuit: (on: boolean) => void;
}

export interface UpdateDeps {
  mode: UpdateMode;
  version: string;
  now: () => number;
  settings: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
  };
  /** Windows: the feed that downloads and installs. */
  feed?: InstallFeed;
  /** The Mac: the newest version on dl.ownbase.site, when newer than this one, or null. */
  latest?: () => Promise<string | null>;
  hosting: () => HostingNow;
  /** Saves everything, stops hosting, and installs and opens the new version. */
  install: () => void;
  onChange: (status: UpdateStatus) => void;
  log?: (message: string, error?: unknown) => void;
}

/**
 * Looks for new versions, downloads them on Windows, and says when one is
 * ready, following the rules above. Nothing here touches the network itself:
 * `feed` and `latest` do, and only when `checkDue` says so.
 */
export class Updates {
  private kept: Kept = { automatic: true, ranVersion: null, checkedAt: null, lastOffer: null };
  private loaded = false;
  private phase: UpdateStatus["phase"] = "idle";
  private newVersion: string | null = null;
  private progress: number | null = null;
  private error: string | null = null;
  private inCall = false;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: UpdateDeps) {}

  async load(): Promise<void> {
    this.kept = readKept(await this.deps.settings.get(UPDATES_KEY).catch(() => null));
    this.loaded = true;
    const { version } = this.deps;
    if (this.kept.ranVersion !== version) {
      if (this.kept.ranVersion)
        this.deps.log?.(`Updated from ${this.kept.ranVersion} to ${version}.`);
      await this.keep({ ranVersion: version }).catch(() => {});
    }
    this.deps.feed?.installOnQuit(this.kept.automatic);
  }

  status(): UpdateStatus {
    const ready = this.phase === "ready" || this.phase === "available";
    return {
      mode: this.deps.mode,
      version: this.deps.version,
      automatic: this.kept.automatic,
      phase: this.phase,
      ...(this.newVersion ? { newVersion: this.newVersion } : {}),
      ...(this.progress !== null ? { progress: this.progress } : {}),
      ...(this.kept.checkedAt !== null ? { checkedAt: this.kept.checkedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
      offer:
        ready &&
        offerDue({
          newVersion: this.newVersion,
          lastOffer: this.kept.lastOffer,
          now: this.deps.now(),
        }),
    };
  }

  /** Looks if it is time to, or at once when the person asked. */
  tick(asked = false): Promise<void> {
    if (this.running) return this.running;
    if (!this.loaded) return Promise.resolve();
    const due = checkDue({
      mode: this.deps.mode,
      automatic: this.kept.automatic,
      asked,
      checkedAt: this.kept.checkedAt,
      ready: this.phase === "ready" || this.phase === "available",
      now: this.deps.now(),
    });
    if (!due) {
      // A notice put off yesterday is due again today.
      this.changed();
      return Promise.resolve();
    }
    this.running = this.look().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async look(): Promise<void> {
    const before = this.phase;
    this.phase = before === "ready" ? "ready" : "checking";
    this.error = null;
    this.changed();
    try {
      const found =
        this.deps.mode === "install" ? await this.deps.feed!.check() : await this.deps.latest!();
      await this.keep({ checkedAt: this.deps.now() });
      this.deps.log?.(`${this.deps.version} looked for a new version: ${found ?? "none newer"}.`);
      if (found === null) {
        this.phase = before === "ready" || before === "available" ? before : "idle";
        this.changed();
        return;
      }
      if (this.deps.mode === "notify") {
        this.newVersion = found;
        this.phase = "available";
        this.changed();
        return;
      }
      if (before === "ready" && found === this.newVersion) {
        this.phase = "ready";
        this.changed();
        return;
      }
      this.phase = "downloading";
      this.newVersion = found;
      this.progress = 0;
      this.changed();
      await this.deps.feed!.download((percent) => {
        this.progress = Math.max(0, Math.min(100, Math.round(percent)));
        this.changed();
      });
      this.progress = null;
      this.phase = "ready";
      this.deps.log?.(`Downloaded ${found}. It installs on restart or when OwnBase quits.`);
      this.changed();
    } catch (error) {
      this.deps.log?.("OwnBase: could not check for or download a new version.", error);
      this.progress = null;
      this.phase = before === "ready" ? "ready" : "failed";
      this.error = "Could not check for a new version. OwnBase tries again in a few hours.";
      // A failure counts as a look, so a feed that is down is not asked again at once.
      await this.keep({ checkedAt: this.deps.now() }).catch(() => {});
      this.changed();
    }
  }

  async setAutomatic(on: boolean): Promise<UpdateStatus> {
    await this.keep({ automatic: on });
    this.deps.feed?.installOnQuit(on);
    this.changed();
    if (on) void this.tick();
    return this.status();
  }

  async check(): Promise<UpdateStatus> {
    await this.tick(true);
    return this.status();
  }

  reportCall(on: boolean): void {
    this.inCall = on;
  }

  async later(): Promise<void> {
    if (!this.newVersion) return;
    await this.keep({ lastOffer: { version: this.newVersion, at: this.deps.now(), putOff: true } });
    this.changed();
  }

  /**
   * Restarts into the downloaded version, or says why not. Where the restart
   * disconnects people, the first call returns the question for the window to
   * ask in its own dialog, and the window calls again with `confirmed`. A
   * call started while the question was open is refused then too.
   */
  async restart(confirmed = false): Promise<UpdateRestart> {
    if (this.deps.mode !== "install" || this.phase !== "ready")
      return { restarting: false, reason: "No new version is ready to install yet." };
    const answer = restartAnswer({ inCall: this.inCall, hosting: this.deps.hosting() });
    if (answer.kind === "refuse") return { restarting: false, reason: answer.reason };
    if (answer.kind === "ask" && !confirmed)
      return { restarting: false, question: answer.question };
    this.deps.log?.(`Restarting to install ${this.newVersion} over ${this.deps.version}.`);
    this.deps.install();
    return { restarting: true };
  }

  private async keep(change: Partial<Kept>): Promise<void> {
    this.kept = { ...this.kept, ...change };
    await this.deps.settings.set(UPDATES_KEY, this.kept);
  }

  private changed(): void {
    const status = this.status();
    // Offered now, the day it may show for starts now.
    const last = this.kept.lastOffer;
    if (status.offer && status.newVersion && (last?.version !== status.newVersion || last.putOff))
      void this.keep({
        lastOffer: { version: status.newVersion, at: this.deps.now(), putOff: false },
      }).catch((error: unknown) =>
        this.deps.log?.("OwnBase: could not save the update notice.", error),
      );
    this.deps.onChange(status);
  }
}
