/**
 * What a packaged desktop app costs to start, compared between two builds
 * (F15: dropping dependency TypeScript from the archive). Each round
 * launches each build in turn on a fresh profile and times:
 *
 * - launch: from starting the executable to the welcome screen showing;
 * - hosting: from "Start hosting" to the new workspace asking for an account,
 *   which is when the main process loads the workspace server and its
 *   dependencies from the archive.
 *
 * It also reads the app's processes' memory (Electron's working-set figures,
 * summed) once the welcome screen has settled and again once hosting.
 * Builds alternate, so a warm disk cache favours neither; the first round
 * of each warms it and is left out. Run where the app can show a window
 * (under xvfb-run on Linux):
 *
 *   node --experimental-strip-types scripts/measure-desktop-start.mts \
 *     --a=path/to/one/executable --b=path/to/other/executable [--rounds=12]
 */
import { _electron as electron } from "@playwright/test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";

const option = (name: string) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
const builds = { a: option("a")!, b: option("b")! };
if (!builds.a || !builds.b) throw new Error("Give both builds: --a=<executable> --b=<executable>");
const ROUNDS = Number(option("rounds") ?? 12);

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};
const summary = (values: number[]) => ({
  median: Number(percentile(values, 50).toFixed(1)),
  p95: Number(percentile(values, 95).toFixed(1)),
  min: Number(Math.min(...values).toFixed(1)),
});

type Sample = {
  launchMs: number;
  hostingMs: number;
  idleMiB: number;
  idleMainMiB: number;
  hostingMiB: number;
  hostingMainMiB: number;
};

async function round(executable: string): Promise<Sample> {
  const data = mkdtempSync(join(tmpdir(), "ownbase-start-"));
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env;
  const began = performance.now();
  const app = await electron.launch({
    executablePath: executable,
    env: { ...inherited, OWNBASE_TEST: "1", OWNBASE_USER_DATA_DIR: data },
  });
  try {
    const page = await app.firstWindow();
    await page.getByText("Find your workspace", { exact: true }).waitFor({ timeout: 60_000 });
    const launchMs = performance.now() - began;
    // Electron reports working sets in KiB, per process.
    const memory = async () => {
      const metrics = await app.evaluate(({ app }) =>
        app.getAppMetrics().map((m) => ({ type: m.type, kib: m.memory.workingSetSize })),
      );
      const total = metrics.reduce((sum, m) => sum + m.kib, 0) / 1024;
      const main =
        metrics.filter((m) => m.type === "Browser").reduce((s, m) => s + m.kib, 0) / 1024;
      return { total, main };
    };
    await page.waitForTimeout(2_000);
    const idle = await memory();
    await page.getByRole("button", { name: "Host a workspace on this computer" }).click();
    await page.getByPlaceholder("Workspace name (e.g. Rocket Team)").fill("Measured");
    const hosting = performance.now();
    await page.getByRole("button", { name: "Start hosting", exact: true }).click();
    await page.getByLabel("Username", { exact: true }).waitFor({ timeout: 60_000 });
    const hostingMs = performance.now() - hosting;
    await page.waitForTimeout(2_000);
    const hosted = await memory();
    return {
      launchMs,
      hostingMs,
      idleMiB: idle.total,
      idleMainMiB: idle.main,
      hostingMiB: hosted.total,
      hostingMainMiB: hosted.main,
    };
  } finally {
    // Hosting, a plain close would wait on a confirmation; end it outright.
    app.process().kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const samples: Record<"a" | "b", Sample[]> = { a: [], b: [] };
for (let i = 0; i <= ROUNDS; i++) {
  for (const which of i % 2 ? (["b", "a"] as const) : (["a", "b"] as const)) {
    const sample = await round(builds[which]);
    if (i > 0) samples[which].push(sample);
  }
}
const archive = (executable: string) =>
  statSync(join(dirname(executable), "resources", "app.asar")).size;
const report = (which: "a" | "b") => ({
  executable: builds[which],
  archiveBytes: archive(builds[which]),
  launchMs: summary(samples[which].map((s) => s.launchMs)),
  hostingMs: summary(samples[which].map((s) => s.hostingMs)),
  idleMiB: summary(samples[which].map((s) => s.idleMiB)),
  idleMainMiB: summary(samples[which].map((s) => s.idleMainMiB)),
  hostingMiB: summary(samples[which].map((s) => s.hostingMiB)),
  hostingMainMiB: summary(samples[which].map((s) => s.hostingMainMiB)),
});
console.log(
  JSON.stringify(
    {
      node: process.version,
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
      rounds: ROUNDS,
      a: report("a"),
      b: report("b"),
    },
    null,
    2,
  ),
);
