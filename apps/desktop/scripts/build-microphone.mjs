// Builds the Windows microphone helper (native/OwnBaseMicrophone.cs) into
// native/bin/ownbase-microphone.exe, which the packaged app carries as an
// extra resource. It is compiled by the C# compiler that comes with Windows'
// .NET Framework 4, so building it needs nothing installed, and running it
// needs only what Windows 10 and 11 already have. Elsewhere the folder is
// made and left empty: only Windows uses the helper.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native", "OwnBaseMicrophone.cs");
const out = join(root, "native", "bin");
const exe = join(out, "ownbase-microphone.exe");

mkdirSync(out, { recursive: true });
if (process.platform !== "win32") process.exit(0);

// Up to date: dev starts often, and compiling takes a second or two.
if (existsSync(exe) && statSync(exe).mtimeMs >= statSync(source).mtimeMs) process.exit(0);

const windows = process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows";
const csc = ["Framework64", "Framework"]
  .map((framework) => join(windows, "Microsoft.NET", framework, "v4.0.30319", "csc.exe"))
  .find((path) => existsSync(path));
if (!csc) {
  console.error("build-microphone: Windows' C# compiler (.NET Framework 4) was not found.");
  process.exit(1);
}
execFileSync(
  csc,
  ["/nologo", "/optimize+", "/target:exe", "/platform:anycpu", `/out:${exe}`, source],
  { stdio: "inherit" },
);
