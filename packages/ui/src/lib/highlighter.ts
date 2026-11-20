import { refractor } from "refractor/core";
import bash from "refractor/bash";
import c from "refractor/c";
import cpp from "refractor/cpp";
import csharp from "refractor/csharp";
import css from "refractor/css";
import diff from "refractor/diff";
import docker from "refractor/docker";
import go from "refractor/go";
import java from "refractor/java";
import javascript from "refractor/javascript";
import json from "refractor/json";
import markdown from "refractor/markdown";
import markup from "refractor/markup";
import php from "refractor/php";
import python from "refractor/python";
import ruby from "refractor/ruby";
import rust from "refractor/rust";
import sql from "refractor/sql";
import typescript from "refractor/typescript";
import yaml from "refractor/yaml";

/** The colours a code block draws: one theme variable each. */
export type SyntaxKind =
  | "comment"
  | "keyword"
  | "string"
  | "number"
  | "name"
  | "punctuation"
  | "added"
  | "removed";

/** A stretch of a block's code and its colour; null is the block's own text colour. */
export type CodeRun = readonly [text: string, kind: SyntaxKind | null];

for (const syntax of [
  markup,
  css,
  javascript,
  typescript,
  json,
  python,
  go,
  rust,
  java,
  c,
  cpp,
  csharp,
  bash,
  sql,
  yaml,
  docker,
  diff,
  markdown,
  ruby,
  php,
])
  refractor.register(syntax);

/**
 * Prism's token names, and its aliases for them, by the colour each takes.
 * A token named nothing here takes the colour of the token around it.
 */
const KINDS: Record<string, SyntaxKind> = {
  comment: "comment",
  prolog: "comment",
  doctype: "comment",
  cdata: "comment",
  shebang: "comment",
  coord: "comment",
  keyword: "keyword",
  atrule: "keyword",
  important: "keyword",
  rule: "keyword",
  title: "keyword",
  directive: "keyword",
  string: "string",
  char: "string",
  "attr-value": "string",
  regex: "string",
  url: "string",
  code: "string",
  number: "number",
  boolean: "number",
  constant: "number",
  symbol: "number",
  entity: "number",
  function: "name",
  "class-name": "name",
  tag: "name",
  "attr-name": "name",
  property: "name",
  builtin: "name",
  variable: "name",
  selector: "name",
  namespace: "name",
  key: "name",
  punctuation: "punctuation",
  operator: "punctuation",
  inserted: "added",
  "inserted-sign": "added",
  deleted: "removed",
  "deleted-sign": "removed",
};

type Node = ReturnType<typeof refractor.highlight>["children"][number];

function kindOf(node: Node): SyntaxKind | null {
  if (node.type !== "element") return null;
  const classes = node.properties.className;
  if (!Array.isArray(classes)) return null;
  // The token's own name, then its aliases: a diff's "deleted-sign" is "deleted" too.
  for (const name of classes) {
    const kind = typeof name === "string" && Object.hasOwn(KINDS, name) ? KINDS[name] : undefined;
    if (kind) return kind;
  }
  return null;
}

/**
 * `code` cut into runs of one colour each, in order. Joined, they are `code`
 * exactly, so copying and reading a block are what they were without colour.
 */
export function highlight(code: string, language: string): CodeRun[] {
  const runs: [string, SyntaxKind | null][] = [];
  const walk = (nodes: readonly Node[], inherited: SyntaxKind | null) => {
    for (const node of nodes) {
      if (node.type === "text") {
        const last = runs.at(-1);
        if (last && last[1] === inherited) last[0] += node.value;
        else runs.push([node.value, inherited]);
      } else if (node.type === "element") {
        walk(node.children, kindOf(node) ?? inherited);
      }
    }
  };
  walk(refractor.highlight(code, language).children, null);
  return runs;
}
