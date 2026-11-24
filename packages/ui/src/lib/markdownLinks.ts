/**
 * "[words](https://…)", as Discord and Markdown write a link, turned into
 * Mrkdwn's "<https://…|words>", which OwnBase and Slack both read. Code, in
 * backticks or a fenced block, is left exactly as typed, and so are words
 * that cannot sit inside a link's brackets.
 */
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const LINK = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s()<>|]+)\)/g;

export function markdownLinks(text: string): string {
  if (!text.includes("](")) return text;
  let out = "";
  let at = 0;
  for (const code of text.matchAll(CODE)) {
    out += linksIn(text.slice(at, code.index)) + code[0];
    at = code.index + code[0].length;
  }
  return out + linksIn(text.slice(at));
}

function linksIn(part: string): string {
  return part.replace(LINK, (whole, words: string, url: string) =>
    /[<>|]/.test(words) ? whole : `<${url}|${words}>`,
  );
}
