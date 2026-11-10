/**
 * The OwnBase server with its Enterprise edition: the command line's entry
 * for builds that include ee/ (P6). Without a license that is the free
 * edition, flag for flag.
 */
import { fileURLToPath } from "node:url";
import { runServerCli } from "@ownbase/server/cli";
import { enterpriseCommandLine } from "./enterprise.js";

await runServerCli({
  extensions: [enterpriseCommandLine],
  script: fileURLToPath(import.meta.url),
});
