import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve, relative, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = "docs/PROJECT-VISUALIZER.html";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const read = (path) => readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const owned = [
  "scripts/generate-project-visualizer.mjs",
  "scripts/generate-project-visualizer.test.mjs",
  "scripts/serve-project-visualizer.mjs",
];
function walk(directory) {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : [path];
  });
}
const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
const paths = [...new Set([...tracked, ...owned, ...walk("docs/visualizer")])]
  .filter((path) => path !== outputPath)
  .sort();
const pathSet = new Set(paths);
const packages = paths
  .filter((path) => path.endsWith("/package.json"))
  .map((path) => {
    const pkg = JSON.parse(read(path));
    return {
      name: pkg.name,
      folder: posix.dirname(path),
      description: pkg.description ?? "",
      main: pkg.main,
      exports: pkg.exports,
    };
  });
const catalogs = ["client", "server", "desktop"].map((name) =>
  JSON.parse(read(`docs/visualizer/content/${name}.json`)),
);
const annotations = new Map();
for (const catalog of catalogs) {
  for (const entry of catalog.entries) {
    if (!pathSet.has(entry.path))
      throw new Error(`Explanation references missing file: ${entry.path}`);
    if (annotations.has(entry.path)) throw new Error(`Duplicate explanation: ${entry.path}`);
    annotations.set(entry.path, entry);
  }
}
const optimizations = JSON.parse(read("docs/visualizer/content/optimizations.json")).items;
const guide = JSON.parse(read("docs/visualizer/content/guide.json"));

function areaFor(path) {
  if (path.startsWith("docs/visualizer/")) return "visualizer";
  if (path.startsWith("docs/")) return "docs";
  if (path.startsWith("packages/")) return path.split("/")[1];
  if (path.startsWith("apps/")) return path.split("/")[1];
  if (
    path.startsWith("scripts/") ||
    path.startsWith("tests/") ||
    path.startsWith(".github/") ||
    path.startsWith("docker/")
  )
    return "tooling";
  return "root";
}
function kindFor(path) {
  if (/\.(png|ico|jpg|jpeg|webp|gif)$/i.test(path)) return "asset";
  if (/\.(test|spec)\./.test(path) || /\/test\//.test(path) || path.startsWith("tests/"))
    return "test";
  if (/\.(md|txt|log)$/.test(path) || path === "LICENSE") return "documentation";
  if (path.startsWith("scripts/")) return "tooling";
  if (
    /\.(json|ya?ml)$/.test(path) ||
    /(^|\/)(Dockerfile|\.[^/]+)$/.test(path) ||
    /\.config\./.test(path)
  )
    return "configuration";
  if (/\.(svg|css)$/.test(path)) return "asset";
  return "runtime";
}
function resolveImport(path, specifier) {
  let base;
  if (specifier.startsWith(".")) base = posix.normalize(posix.join(posix.dirname(path), specifier));
  else {
    const pkg = packages.find(
      (entry) => specifier === entry.name || specifier.startsWith(`${entry.name}/`),
    );
    if (pkg) {
      const key = specifier === pkg.name ? "." : `.${specifier.slice(pkg.name.length)}`;
      const declared =
        typeof pkg.exports === "string" ? (key === "." ? pkg.exports : null) : pkg.exports?.[key];
      const target =
        typeof declared === "string"
          ? declared
          : (declared?.types ?? declared?.import ?? declared?.default);
      if (typeof target === "string") base = posix.join(pkg.folder, target);
    }
  }
  if (!base) return null;
  const stem = base.replace(/\.(js|mjs|cjs)$/, "");
  return (
    [
      base,
      ...[".ts", ".tsx", ".mts", ".js", ".mjs", ".json", ".css", "/index.ts", "/index.tsx"].map(
        (suffix) => stem + suffix,
      ),
    ].find((candidate) => pathSet.has(candidate)) ?? null
  );
}
function analyze(path, source) {
  const symbols = [],
    imports = [],
    checks = [];
  if (!/\.(tsx?|mts|cts|jsx?|mjs|cjs)$/.test(path)) return { symbols, imports, checks };
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const lineOf = (node) => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
  const addSymbol = (node, name, kind) => {
    if (!name) return;
    const comments = (node.jsDoc ?? [])
      .map((doc) => (typeof doc.comment === "string" ? doc.comment : ""))
      .filter(Boolean);
    const prefix = node.getText(ast).split("\n")[0].slice(0, 220);
    symbols.push({
      name,
      kind,
      line: lineOf(node),
      end: ast.getLineAndCharacterOfPosition(node.end).line + 1,
      signature: prefix,
      comment: comments.join("\n"),
      exported: (node.modifiers ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ),
    });
  };
  function visit(node) {
    if (ts.isFunctionDeclaration(node)) addSymbol(node, node.name?.text, "function");
    else if (ts.isClassDeclaration(node)) addSymbol(node, node.name?.text, "class");
    else if (ts.isInterfaceDeclaration(node)) addSymbol(node, node.name.text, "interface");
    else if (ts.isTypeAliasDeclaration(node)) addSymbol(node, node.name.text, "type");
    else if (ts.isEnumDeclaration(node)) addSymbol(node, node.name.text, "enum");
    else if (ts.isMethodDeclaration(node)) addSymbol(node, node.name.getText(ast), "method");
    else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && node.parent === ast)
          addSymbol(
            node,
            declaration.name.text,
            declaration.initializer &&
              (ts.isArrowFunction(declaration.initializer) ||
                ts.isFunctionExpression(declaration.initializer))
              ? "function"
              : "value",
          );
      }
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      imports.push({
        specifier,
        path: resolveImport(path, specifier),
        line: lineOf(node),
        typeOnly: Boolean(node.importClause?.isTypeOnly || node.isTypeOnly),
      });
    }
    if (ts.isCallExpression(node)) {
      const call = node.expression.getText(ast);
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first)) {
        if (call === "import" || call === "require")
          imports.push({
            specifier: first.text,
            path: resolveImport(path, first.text),
            line: lineOf(node),
            typeOnly: false,
            dynamic: call === "import",
          });
        if (/^(it|test|describe)(\.(skip|only|todo))?$/.test(call))
          checks.push({
            name: first.text,
            line: lineOf(node),
            group: call.startsWith("describe"),
            skipped: call.endsWith(".skip") || call.endsWith(".todo"),
          });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { symbols, imports, checks };
}
function describe(path, kind, source, analysis) {
  if (path.endsWith("package.json")) {
    const pkg = JSON.parse(source);
    return {
      plain: "Lists the outside code this package uses and the commands that build and test it.",
      summary: `Package manifest for ${pkg.name ?? "this workspace"}. Defines commands, dependency versions and package entry points.`,
      details: [
        pkg.description ??
          "The package manager reads this file when installing dependencies and running commands.",
        `Commands: ${Object.keys(pkg.scripts ?? {}).join(", ") || "none; this package is consumed by another workspace"}.`,
      ],
      concepts: ["dependencies", "package boundaries"],
    };
  }
  if (kind === "test") {
    const cases = analysis.checks.filter((check) => !check.group).length;
    return {
      plain: cases
        ? `${cases} automatic ${cases === 1 ? "test checks" : "tests check"} that this part of Tandem still behaves as expected.`
        : "Automatic tests that check this part of Tandem still behaves as expected.",
      summary: `Regression coverage in ${posix.basename(path)}. ${analysis.checks.filter((check) => !check.group).length} statically named test cases are indexed below.`,
      details: [
        "The case names and source describe the expected behavior; a test's presence does not prove it was run or passed.",
        "Imports link this coverage to the modules exercised directly. Shared fixtures and indirect runtime calls can extend coverage beyond those links.",
      ],
      concepts: ["regression coverage"],
    };
  }
  if (kind === "documentation") {
    const title = source.match(/^#\s+(.+)$/m)?.[1];
    const headings = [...source.matchAll(/^#{2,3}\s+(.+)$/gm)].map((match) => match[1]);
    return {
      plain: title
        ? `A written guide titled ${title.replace(/[`*_]/g, "")}.`
        : "Notes, guidance or licence text for the project.",
      summary: title
        ? `${title}. Documentation and decisions for this part of the project.`
        : `${posix.basename(path)} records project guidance, output or licensing.`,
      details: headings.length
        ? [
            `Topics: ${headings.slice(0, 12).join("; ")}.`,
            "The source tab includes the complete document, including acceptance criteria and validation limits.",
          ]
        : ["The source tab contains the complete text."],
      concepts: ["documentation"],
    };
  }
  if (kind === "configuration")
    return {
      plain: path.startsWith(".github/")
        ? "Settings for the automatic checks that run on every change."
        : path.includes("tsconfig")
          ? "Settings for checking the code for mistakes before it runs."
          : path.includes("lock")
            ? "The exact versions of all outside code, so every install gets the same."
            : path.includes("Docker") || path.startsWith("docker/")
              ? "Settings for the ready-made server package."
              : "Settings for the tools that build and package Tandem.",
      summary: `${posix.basename(path)} configures ${path.startsWith(".github/") ? "GitHub Actions validation and delivery" : path.includes("tsconfig") ? "TypeScript checking and module compilation" : path.includes("lock") ? "the exact resolved dependency graph" : path.includes("Docker") || path.startsWith("docker/") ? "the self-hosted container" : "workspace tooling or packaging"}.`,
      details: [
        "Keys and commands in the source define the behavior. Configuration is indexed alongside runtime code because it affects what is built, checked and shipped.",
      ],
      concepts: ["configuration"],
    };
  if (kind === "asset")
    return {
      plain: path.endsWith(".css")
        ? "Colours, spacing and layout for what you see."
        : /\.(svg|png|ico)$/.test(path)
          ? "An image or icon Tandem shows."
          : "A file Tandem ships as it is, such as a font.",
      summary: `${posix.basename(path)} supplies ${path.endsWith(".css") ? "styles and layout" : /\.(svg|png|ico)$/.test(path) ? "a visual asset" : "a static asset"} for ${areaFor(path)}.`,
      details: [
        "Text assets can be inspected in the source tab. Binary files have size and hash metadata; their contents are not interpreted as code.",
      ],
      concepts: ["presentation"],
    };
  return {
    plain:
      kind === "tooling"
        ? "A helper script for building, testing or measuring Tandem."
        : "Supporting code with no written explanation yet.",
    summary: `${posix.basename(path)} contains ${
      analysis.symbols
        .slice(0, 3)
        .map((symbol) => symbol.name)
        .join(", ") || "the entry or supporting code"
    } for ${areaFor(path)}.`,
    details: [
      "This description is generated from declarations. Use the symbol index, imports and complete source to examine its implementation.",
    ],
    concepts: [kind === "tooling" ? "developer tooling" : "implementation"],
  };
}
const files = paths.map((path) => {
  const raw = readFileSync(resolve(root, path));
  const binary = /\.(png|ico|jpg|jpeg|webp|gif)$/i.test(path) || raw.includes(0);
  const source = binary ? null : raw.toString("utf8").replace(/\r\n/g, "\n");
  const analysis = analyze(path, source ?? "");
  const kind = kindFor(path);
  const annotation = annotations.get(path);
  return {
    path,
    area: areaFor(path),
    kind,
    bytes: raw.length,
    hash: hash(raw),
    lines: source === null ? 0 : source.split("\n").length,
    source,
    curated: Boolean(annotation),
    ...describe(path, kind, source ?? "", analysis),
    ...annotation,
    // A written explanation brings its own plain sentence, or none.
    ...(annotation ? { plain: annotation.plain } : {}),
    ...analysis,
    usedBy: [],
  };
});
const fileMap = new Map(files.map((file) => [file.path, file]));
for (const file of files)
  for (const dependency of file.imports) {
    if (dependency.path) {
      const target = fileMap.get(dependency.path);
      if (!target.usedBy.includes(file.path)) target.usedBy.push(file.path);
    }
  }
const flows = catalogs.flatMap((catalog) =>
  catalog.flows.map((flow) => ({ ...flow, area: catalog.area })),
);
for (const item of [...optimizations, ...flows.flatMap((flow) => flow.steps)]) {
  for (const path of item.files ?? [])
    if (!pathSet.has(path)) throw new Error(`Guide references missing file: ${path}`);
}
for (const item of optimizations)
  for (const evidence of item.evidence ?? [])
    if (!pathSet.has(evidence.path))
      throw new Error(`Evidence references missing file: ${evidence.path}`);
for (const path of [
  ...guide.areas.map((area) => area.entry),
  ...guide.principles.flatMap((principle) => principle.files),
  ...guide.validation.map((record) => record.path),
]) {
  if (!pathSet.has(path)) throw new Error(`Overview references missing file: ${path}`);
}
const ids = new Set();
for (const item of [...optimizations, ...flows]) {
  if (ids.has(item.id)) throw new Error(`Duplicate guide ID: ${item.id}`);
  ids.add(item.id);
}
const runtime = files.filter(
  (file) =>
    /^(packages|apps)\/.+\/src\//.test(file.path) &&
    /\.(tsx?|mts|js|css|html|svg|json)$/.test(file.path),
);
const missing = runtime.filter((file) => !file.curated).map((file) => file.path);
if (missing.length) throw new Error(`Runtime files need explanations:\n${missing.join("\n")}`);
const revision = git("rev-parse", "HEAD");
const data = {
  meta: {
    revision,
    revisionDate: git("show", "-s", "--format=%cI", "HEAD"),
    repository: git("remote", "get-url", "origin")
      .replace(/\.git$/, "")
      .replace(/^git@github.com:/, "https://github.com/"),
    inputDigest: hash(files.map((file) => `${file.path}\0${file.hash}`).join("\n")),
    trackedCount: tracked.filter((path) => path !== outputPath).length,
    fileCount: files.length,
    runtimeCount: runtime.length,
    explainedRuntime: runtime.filter((file) => file.curated).length,
    textCount: files.filter((file) => file.source !== null).length,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    symbols: files.reduce((sum, file) => sum + file.symbols.length, 0),
    edges: files.reduce(
      (sum, file) => sum + file.imports.filter((dependency) => dependency.path).length,
      0,
    ),
  },
  guide,
  files,
  flows,
  optimizations,
  areas: catalogs.map(({ area, overview }) => ({ area, overview })),
};
const checking = process.argv.includes("--check");
let existing;
if (checking) {
  existing = read(outputPath);
  const embedded = JSON.parse(
    existing.match(
      /<script id="project-data" type="application\/json">([\s\S]*?)<\/script>/,
    )?.[1] ?? "null",
  );
  if (!embedded?.meta) throw new Error("Missing visualizer snapshot metadata.");
  // A commit changes HEAD and tracked status without changing source. Freshness
  // compares actual input bytes and generated content, retaining capture metadata.
  for (const key of ["revision", "revisionDate", "trackedCount"])
    data.meta[key] = embedded.meta[key];
}
// The page carries Tandem's own faces so it looks the same offline. They come
// from the web app's installed packages; a checkout without apps/web (the
// freshness fixture) falls back to system fonts.
const faces = [
  ["Onest Variable", "onest", "100 900"],
  ["Geist Mono Variable", "geist-mono", "100 900"],
];
function fontFaces() {
  if (!existsSync(resolve(root, "apps/web/package.json"))) return "";
  return faces
    .map(([family, name, weight]) => {
      const file = resolve(
        root,
        `apps/web/node_modules/@fontsource-variable/${name}/files/${name}-latin-wght-normal.woff2`,
      );
      if (!existsSync(file)) throw new Error(`Missing ${file}. Run pnpm install.`);
      const data = readFileSync(file).toString("base64");
      return `@font-face{font-family:"${family}";font-style:normal;font-display:swap;font-weight:${weight};src:url(data:font/woff2;base64,${data}) format("woff2")}\n`;
    })
    .join("");
}
const parts = {
  STYLES: fontFaces() + read("docs/visualizer/style.css"),
  DATA: JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029"),
  APP: read("docs/visualizer/app.js"),
};
// One pass over the original template: replacement text can contain both dollar
// tokens and the template's own markers, since source files are embedded too.
const html = read("docs/visualizer/template.html").replace(
  /\/\* VISUALIZER_(STYLES|DATA|APP) \*\//g,
  (_marker, key) => parts[key],
);
if (checking) {
  if (existing !== html) throw new Error("Project visualizer is stale. Run pnpm visualizer:build.");
  console.log(
    `Visualizer is current: ${files.length} files, ${runtime.length}/${runtime.length} runtime explanations, ${flows.length} flows, ${optimizations.length} improvements.`,
  );
} else {
  writeFileSync(resolve(root, outputPath), html);
  console.log(
    `Wrote ${relative(root, resolve(root, outputPath))}: ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MiB; ${files.length} files; ${runtime.length}/${runtime.length} runtime explanations.`,
  );
}
