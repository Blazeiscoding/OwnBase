import { fileURLToPath } from "node:url";
import { runServerCli } from "./cli/run.js";

await runServerCli({ script: fileURLToPath(import.meta.url) });
