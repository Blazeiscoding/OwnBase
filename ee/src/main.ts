/**
 * The OwnBase server with its Enterprise edition: the command line's entry
 * for builds that include ee/ (P6). It puts the Enterprise extension in the
 * command line's registry, then runs the server's own main.ts, which reads
 * it. Without a license that is the free edition, flag for flag.
 */
import { addCommandLineExtension } from "@slackoss/server/extensions";
import { enterpriseCommandLine } from "./enterprise.js";

addCommandLineExtension(enterpriseCommandLine);
await import("@slackoss/server/main");
