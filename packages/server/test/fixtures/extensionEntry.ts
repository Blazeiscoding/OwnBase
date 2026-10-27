// A build's entry with one command-line extension, as ee/src/main.ts is one:
// it registers the extension, then runs the server's own main.ts (P6).
import { ConfigError, addCommandLineExtension } from "../../src/extensions.js";

addCommandLineExtension({
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
});
await import("../../src/main.js");
