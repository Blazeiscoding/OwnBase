import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { Plugin } from "vite";

/**
 * Writes a Brotli and a gzip copy beside each text file of the built client
 * (REV-13), so the server can send whichever the browser accepts without
 * compressing on every request. Done once, at build time, so it can afford
 * the slowest, smallest settings.
 */
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".svg", ".json", ".txt", ".map"]);
/** Below this, the headers outweigh what compression saves. */
const MIN_BYTES = 1024;

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

export interface Precompressed {
  file: string;
  bytes: number;
  br?: number;
  gz?: number;
}

async function* files(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

/** Compresses every text file under `dir`, keeping a copy only when it is smaller. */
export async function precompressDirectory(dir: string): Promise<Precompressed[]> {
  const written: Precompressed[] = [];
  for await (const file of files(dir)) {
    if (!COMPRESSIBLE.has(extname(file))) continue;
    const source = await readFile(file);
    if (source.length < MIN_BYTES) continue;
    const [br, gz] = await Promise.all([
      brotli(source, {
        params: {
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
        },
      }),
      gzipped(source, { level: constants.Z_BEST_COMPRESSION }),
    ]);
    const result: Precompressed = { file, bytes: source.length };
    if (br.length < source.length) {
      await writeFile(`${file}.br`, br);
      result.br = br.length;
    }
    if (gz.length < source.length) {
      await writeFile(`${file}.gz`, gz);
      result.gz = gz.length;
    }
    written.push(result);
  }
  return written;
}

/** The build step: compresses the output directory once everything is written. */
export function precompress(): Plugin {
  let outDir = "";
  return {
    name: "ownbase-precompress",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async writeBundle() {
      await precompressDirectory(outDir);
    },
  };
}
