// A build's entry with one command-line extension, as ee/src/main.ts is one (P6).
import { fileURLToPath } from "node:url";
import { runServerCli } from "../../src/cli/run.js";
import { ConfigError, type CommandLineExtension } from "../../src/extensions.js";

const greeting: CommandLineExtension = {
  options: { greeting: { type: "string" } },
  help: `Greeting

  --greeting <words>  What the test extension says on starting.`,
  create(values, env) {
    const greeting = (values.greeting as string | undefined) ?? env("GREETING");
    if (greeting === "refuse") throw new ConfigError("--greeting: not that one");
    return {
      name: "greeting",
      status: () => ({
        name: "greeting",
        summary: `Greeting: ${greeting ?? "none"}`,
        health: "ok",
      }),
    };
  },
};

await runServerCli({ extensions: [greeting], script: fileURLToPath(import.meta.url) });
