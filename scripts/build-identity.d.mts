/** Types for build-identity.mjs, for the TypeScript that builds and tests with it. */
export interface BuildIdentity {
  version: string;
  revision: string;
  dirty: boolean | null;
  inputs: string;
  builtAt: string;
}
export type Artifact = "web" | "server" | "desktop";
export const ROOT: string;
export const ARTIFACTS: Record<Artifact, { manifest: string; inputs: string[]; rebuild: string }>;
export function inputsHash(inputs: string[], root?: string): string;
export function buildIdentity(inputs: string[], root?: string): BuildIdentity;
export function writeBuildIdentity(artifact: Artifact, dir: string, root?: string): BuildIdentity;
export function readAsarFile(archive: string, path: string): string | null;
export function staleness(
  artifact: Artifact,
  manifestText: string | null,
  root?: string,
): string | null;
export function check(names: Artifact[], root?: string): string[];
export function packagedResources(platform?: string): string;
