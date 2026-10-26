/**
 * The templates Apps and integrations starts from (UX-63): what each one is
 * for, and the examples it gives to copy. Each example is meant to work when
 * pasted as it is, which `appTemplates.test.ts` checks by running the slash
 * command service against a signed request.
 */

export type AppTemplate = "webhook" | "command" | "ci";

export const APP_TEMPLATES: readonly AppTemplate[] = ["webhook", "command", "ci"];

export const TEMPLATE_TITLES: Record<AppTemplate, string> = {
  webhook: "Incoming webhook",
  command: "Slash command",
  ci: "Post CI results",
};

/** The message the curl example posts. Send test message posts the same one. */
export const WEBHOOK_EXAMPLE = { text: "Hello from a webhook" };

/** What the CI example posts after a passing build, marked as a test. */
export const CI_TEST_MESSAGE = {
  text: "*CI* success on `main` (a test message from Apps and integrations)",
};

/**
 * The repository secret the CI example reads the webhook's URL from. The URL
 * is the whole of a webhook's authority, so it does not belong in a workflow
 * file that anyone who can read the repository can read.
 */
export const CI_SECRET = "OWNBASE_WEBHOOK_URL";

/** The name a template gives the app it makes, which the admin can change first. */
export function suggestedAppName(template: AppTemplate, command: string): string {
  if (template === "webhook") return "Webhook";
  if (template === "ci") return "CI";
  return command ? `${command[0]!.toUpperCase()}${command.slice(1)} Bot` : "Command Bot";
}

/**
 * A command as the server stores it: no leading slash, lower case. Anything
 * else the server refuses with its own message, which the dialog shows.
 */
export function commandName(typed: string): string {
  return typed.trim().replace(/^\//, "").toLowerCase();
}

/** Posts the example message to a webhook from a terminal. */
export function curlExample(url: string): string {
  return [
    `curl -X POST '${url}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${JSON.stringify(WEBHOOK_EXAMPLE)}'`,
  ].join("\n");
}

/**
 * A GitHub Actions step that posts how the job went. It goes last in a job,
 * and runs whether the job passed or not. The message is put together by `jq`
 * from environment variables rather than written into the script, so a branch
 * or workflow name with a quote in it cannot break the JSON or the shell.
 */
export function ciExample(): string {
  return [
    "- name: Post the result to OwnBase",
    "  if: always()",
    "  shell: bash",
    "  env:",
    `    ${CI_SECRET}: \${{ secrets.${CI_SECRET} }}`,
    '    TEXT: "*${{ github.workflow }}* ${{ job.status }} on `${{ github.ref_name }}`: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"',
    "  run: |",
    "    jq -n --arg text \"$TEXT\" '{text: $text}' |",
    `      curl -fsS -X POST "$${CI_SECRET}" -H 'Content-Type: application/json' --data-binary @-`,
  ].join("\n");
}

/**
 * A service that answers a slash command, in Node with nothing to install. It
 * checks the signature as INTEGRATIONS.md describes, since a command's
 * request URL can be called by anyone who learns it, and answers privately to
 * whoever ran the command so a test does not post to the whole channel.
 */
export function commandExample(command: string, signingSecret: string | null): string {
  const name = command || "deploy";
  const secret = signingSecret ?? "paste the app's signing secret here";
  return [
    `// Answers /${name} for OwnBase. It needs Node.js 18 or later and nothing else:`,
    `// save it as ${name}.mjs, run \`node ${name}.mjs\`, and give the command the`,
    "// address it answers on as its request URL.",
    'import { createServer } from "node:http";',
    'import { createHmac, timingSafeEqual } from "node:crypto";',
    "",
    `const signingSecret = ${JSON.stringify(secret)};`,
    "",
    "/** Whether the workspace sent this, in the last five minutes. */",
    "function signed(headers, body) {",
    '  const timestamp = Number(headers["x-slack-request-timestamp"]);',
    "  if (!Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;",
    "  const expected = Buffer.from(",
    '    "v0=" + createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex"),',
    "  );",
    '  const given = Buffer.from(String(headers["x-slack-signature"] ?? ""));',
    "  return given.length === expected.length && timingSafeEqual(given, expected);",
    "}",
    "",
    "createServer((req, res) => {",
    '  let body = "";',
    '  req.on("data", (chunk) => (body += chunk));',
    '  req.on("end", () => {',
    "    if (!signed(req.headers, body)) {",
    "      res.writeHead(401).end();",
    "      return;",
    "    }",
    "    const form = new URLSearchParams(body);",
    '    // Add response_type: "in_channel" to post the answer for everyone.',
    '    res.writeHead(200, { "content-type": "application/json" });',
    "    res.end(",
    "      JSON.stringify({",
    '        text: `Got ${form.get("command")} ${form.get("text")} from @${form.get("user_name")}`,',
    "      }),",
    "    );",
    "  });",
    "}).listen(Number(process.env.PORT ?? 3000));",
  ].join("\n");
}
