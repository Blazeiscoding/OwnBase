/**
 * The environment variables the license is read from, each as `OWNBASE_<name>`:
 * the license file's path, or the license itself. OwnBase's hosting passes
 * both on to the workspace servers it runs.
 */
export const LICENSE_ENV = ["LICENSE_FILE", "LICENSE"] as const;
