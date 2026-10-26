import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { needsInstaller, selectDesktopMode } from "./desktop-ci-mode.mjs";

test("installer resources, manifests, and selection policy keep full packaging", () => {
  for (const path of [
    "apps/desktop/build/icon.ico",
    "apps/desktop/electron-builder.yml",
    "packages/server/package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    ".pnpmfile.cjs",
    "scripts/generate-icons.mjs",
    "scripts/desktop-ci-mode.mjs",
    ".github/workflows/desktop.yml",
  ]) {
    assert.equal(needsInstaller(["packages/ui/src/components/Composer.tsx", path]), true, path);
  }
});

test("runtime edits use unpacked packaging", () => {
  assert.equal(
    needsInstaller([
      "apps/desktop/src/main/index.ts",
      "apps/web/vite.config.ts",
      "packages/server/src/server.ts",
      "packages/ui/src/components/Composer.tsx",
    ]),
    false,
  );
});

test("manual runs default to an installer and accept explicit unpacked selection", () => {
  assert.equal(selectDesktopMode({ eventName: "workflow_dispatch" }).installer, true);
  assert.equal(
    selectDesktopMode({ eventName: "workflow_dispatch", installer: "false" }).installer,
    false,
  );
});

test("unknown events and missing or malformed bases retain installer coverage", () => {
  for (const input of [
    {},
    { eventName: "pull_request" },
    { eventName: "pull_request", baseSha: "--output=somewhere" },
    { eventName: "push", baseSha: "a".repeat(40) },
  ]) {
    assert.equal(selectDesktopMode(input).installer, true);
  }
});

test("the real Git diff detects packaging changes and falls back safely for missing history", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ownbase-desktop-ci-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=CI fixture",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
  };
  try {
    git("init", "-q");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(cwd, "runtime.ts"), "export const version = 1;\n");
    commit();
    const baseSha = git("rev-parse", "HEAD");
    writeFileSync(join(cwd, "runtime.ts"), "export const version = 2;\n");
    commit();
    assert.equal(selectDesktopMode({ eventName: "pull_request", baseSha, cwd }).installer, false);
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    commit();
    assert.equal(selectDesktopMode({ eventName: "pull_request", baseSha, cwd }).installer, true);
    assert.equal(
      selectDesktopMode({ eventName: "pull_request", baseSha: "f".repeat(40), cwd }).installer,
      true,
    );
  } finally {
    assert.equal(dirname(resolve(cwd)), resolve(tmpdir()));
    assert.ok(basename(cwd).startsWith("ownbase-desktop-ci-"));
    rmSync(cwd, { recursive: true, force: true });
  }
});
