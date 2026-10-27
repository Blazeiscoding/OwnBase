// 1) Restore the `node:` prefix tsup strips from externalized builtins
//    (https://github.com/egoist/tsup/issues — bare "sqlite" is not resolvable).
// 2) Ship the browser client next to the bundled server so it serves it at /.
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { builtinModules } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "../dist/ownbase-server.js");

let src = readFileSync(bundle, "utf8");
// Prefix-only builtins (sqlite, test, sea) are missing from builtinModules.
for (const mod of [...builtinModules, "sqlite", "sea", "test"]) {
  src = src.replaceAll(`from "${mod}"`, `from "node:${mod}"`);
  src = src.replaceAll(`require("${mod}")`, `require("node:${mod}")`);
}
writeFileSync(bundle, src);
console.log("normalized node: builtin imports");

const webDist = join(here, "../../web/dist");
const target = join(here, "../dist/web");
if (existsSync(webDist)) {
  cpSync(webDist, target, { recursive: true });
  console.log("bundled web client into dist/web");
} else {
  console.warn("apps/web/dist not found — build @ownbase/web first for the browser client");
}
