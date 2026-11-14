// Checks an OCI archive from `docker buildx build -o type=oci` before anything
// pushes it: it holds one image index, with an image for each platform named
// and no other, and its linux/amd64 image has the very layers and settings of
// the image the tests ran (`tested`, a tag in the local Docker). Prints the
// index's digest, which a registry keeps when the archive is copied with its
// digests preserved.
//
//   node check-archive.mjs <archive> <tested> <platform>...
import { execFileSync } from "node:child_process";

const [archive, tested, ...platforms] = process.argv.slice(2);
if (!archive || !tested || platforms.length === 0) {
  console.error("usage: check-archive.mjs <archive> <tested> <platform>...");
  process.exit(2);
}
const INDEX = "application/vnd.oci.image.index.v1+json";
const read = (path) =>
  JSON.parse(
    execFileSync("tar", ["-xOf", archive, path], { encoding: "utf8", maxBuffer: 1 << 26 }),
  );
const blob = (digest) => read(`blobs/sha256/${digest.replace(/^sha256:/, "")}`);
const fail = (problem) => {
  console.error(`::error::${problem}`);
  process.exit(1);
};

const top = read("index.json").manifests ?? [];
if (top.length !== 1 || top[0].mediaType !== INDEX)
  fail(`${archive} should hold one image index, not ${JSON.stringify(top)}`);
const images = new Map(
  blob(top[0].digest).manifests.map((entry) => [
    `${entry.platform?.os}/${entry.platform?.architecture}`,
    entry,
  ]),
);
const found = [...images.keys()].sort();
if (found.join(" ") !== [...platforms].sort().join(" "))
  fail(`${archive} has images for ${found.join(", ")}, not ${platforms.join(", ")}`);

// Compared by content, not by ID: what an image ID is depends on how Docker
// stores images, but the uncompressed layers and the settings do not.
const config = blob(blob(images.get("linux/amd64").digest).config.digest);
const local = JSON.parse(
  execFileSync("docker", ["image", "inspect", tested, "--format", "{{json .}}"], {
    encoding: "utf8",
  }),
);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
if (!same(config.rootfs?.diff_ids, local.RootFS?.Layers))
  fail(`the linux/amd64 image in ${archive} does not have the layers of ${tested}`);
for (const key of ["Entrypoint", "Cmd", "User", "Env", "Labels"])
  if (!same(config.config?.[key], local.Config?.[key]))
    fail(`the linux/amd64 image in ${archive} has another ${key} than ${tested}`);

console.log(top[0].digest);
