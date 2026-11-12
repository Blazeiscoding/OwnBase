import { stat } from "node:fs/promises";
import { extractZipEntry, readZipEntries, readZipEntry, type ZipEntry } from "../backups/zip.js";
import { SlackFormatError } from "./slackFormat.js";

const MB = 1024 * 1024;

/**
 * How much of a zip an import reads. A Slack export of years of history is
 * a few gigabytes and a few hundred thousand files; these leave room for that
 * many times over, and stop a damaged or hostile zip before it fills the
 * disk or the memory. Every one is checked from the zip's directory, before
 * anything is unpacked.
 */
export interface ImportLimits {
  /** The zip itself. */
  zipBytes: number;
  /** Entries in it. */
  entries: number;
  /** One JSON file unpacked, which is read whole. */
  jsonBytes: number;
  /** One attachment, as an upload is held to (100 MB). */
  fileBytes: number;
}

export const IMPORT_LIMITS: ImportLimits = {
  zipBytes: 64 * 1024 * MB,
  entries: 2_000_000,
  jsonBytes: 256 * MB,
  fileBytes: 100 * MB,
};

const megabytes = (bytes: number) => `${Math.round(bytes / MB).toLocaleString("en-US")} MB`;

/** A day's messages: `2024-01-31.json`. */
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

/**
 * A Slack export zip, read one file at a time. A zip made by hand from the
 * unpacked export often has one folder around everything; that folder is
 * looked through. The `__MACOSX` folder a Mac adds is left out.
 */
export class SlackExportZip {
  private constructor(
    private readonly path: string,
    private readonly limits: ImportLimits,
    private readonly entries: Map<string, ZipEntry>,
    private readonly prefix: string,
  ) {}

  static async open(path: string, limits: ImportLimits): Promise<SlackExportZip> {
    const { size } = await stat(path).catch(() => {
      throw new SlackFormatError(`There is no file at ${path}.`);
    });
    if (size > limits.zipBytes)
      throw new SlackFormatError(
        `The zip is ${megabytes(size)}, more than the ${megabytes(limits.zipBytes)} an import reads.`,
      );
    let listed: ZipEntry[];
    try {
      listed = await readZipEntries(path);
    } catch (err) {
      throw new SlackFormatError(`${path} could not be read as a zip: ${(err as Error).message}`);
    }
    if (listed.length > limits.entries)
      throw new SlackFormatError(
        `The zip holds ${listed.length.toLocaleString("en-US")} files, more than the ${limits.entries.toLocaleString("en-US")} an import reads.`,
      );
    const entries = new Map(
      listed.filter((e) => !e.name.startsWith("__MACOSX/")).map((e) => [e.name, e]),
    );
    let prefix = "";
    if (!entries.has("users.json")) {
      const wrapped = [...entries.keys()].filter((name) => /^[^/]+\/users\.json$/.test(name));
      if (wrapped.length !== 1)
        throw new SlackFormatError(
          "This zip has no users.json, so it is not a Slack export. Export from Slack's Workspace settings, under Import and export data.",
        );
      prefix = wrapped[0]!.slice(0, -"users.json".length);
    }
    return new SlackExportZip(path, limits, entries, prefix);
  }

  private find(name: string): ZipEntry | undefined {
    return this.entries.get(this.prefix + name);
  }

  has(name: string): boolean {
    return this.find(name) !== undefined;
  }

  /** A JSON file in the export, parsed; null when the export has none by that name. */
  async json(name: string): Promise<unknown> {
    const entry = this.find(name);
    if (!entry) return null;
    if (entry.size > this.limits.jsonBytes)
      throw new SlackFormatError(
        `${name} is ${megabytes(entry.size)} unpacked, more than the ${megabytes(this.limits.jsonBytes)} an import reads in one file.`,
      );
    const bytes = await readZipEntry(this.path, entry);
    try {
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new SlackFormatError(`${name} is not JSON.`);
    }
  }

  /** The size of a file in the export, or null when there is none by that name. */
  size(name: string): number | null {
    return this.find(name)?.size ?? null;
  }

  /** Unpacks one file of the export to `to`, held to the size of an attachment. */
  async extract(name: string, to: string): Promise<void> {
    const entry = this.find(name);
    if (!entry) throw new SlackFormatError(`${name} is not in the zip.`);
    if (entry.size > this.limits.fileBytes)
      throw new SlackFormatError(
        `${name} is ${megabytes(entry.size)}, more than the ${megabytes(this.limits.fileBytes)} a file can be.`,
      );
    await extractZipEntry(this.path, entry, to);
  }

  /** Every folder of day files, each with its days in order, oldest first. */
  dayFolders(): Map<string, string[]> {
    const folders = new Map<string, string[]>();
    for (const full of this.entries.keys()) {
      if (!full.startsWith(this.prefix)) continue;
      const parts = full.slice(this.prefix.length).split("/");
      if (parts.length !== 2 || !DAY_FILE.test(parts[1]!)) continue;
      const days = folders.get(parts[0]!) ?? [];
      days.push(parts[1]!);
      folders.set(parts[0]!, days);
    }
    for (const days of folders.values()) days.sort();
    return folders;
  }
}
