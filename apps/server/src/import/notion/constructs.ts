// M7 contracts section 4, Notion constructs. The shapes are those a real export writes (M7-T08): each tag on a line of its own, blank lines inside, lists inside, a callout
// indented inside a list item, a callout nested in another. They are converted before the schema sees them ([F§7]: their survival through the schema is not confirmed), so their
// text is the page's text and search finds it.

type Kind = 'aside' | 'details';
const OPEN: Record<Kind, RegExp> = { aside: /^(\s*)<aside>\s*$/, details: /^(\s*)<details>\s*$/ };
const CLOSE: Record<Kind, RegExp> = { aside: /^\s*<\/aside>\s*$/, details: /^\s*<\/details>\s*$/ };
const SUMMARY = /^\s*<summary>(.*)<\/summary>\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
/**
 * A line the bold of a callout's first line must not wrap: a block of its own (a list item, a heading, a quote, a fence, a table row), an HTML tag (an icon picture), or a line that
 * starts with a link (M7-T08: bold that starts on a link and spans two of them does not read back as the same document, so the converter would refuse the page).
 */
const NOT_A_FIRST_LINE = /^(\s*([-*+]|\d{1,9}[.)])\s|\s*#{1,6}\s|\s*>|\s*(`{3,}|~{3,})|\s*\||\s*<[a-zA-Z/]|\s*\[[^\]]*\]\()/;

/** The open and close lines of every block that is closed, outside code fences; a block that is never closed is no block. */
function matchBlocks(lines: readonly string[]): Map<number, { kind: Kind; close: number; indent: string }> {
  const blocks = new Map<number, { kind: Kind; close: number; indent: string }>();
  const open: { kind: Kind; line: number; indent: string }[] = [];
  let fence: string | undefined;
  lines.forEach((line, i) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== undefined) { if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; return; }
    if (marker !== undefined) { fence = marker; return; }
    for (const kind of ['aside', 'details'] as const) {
      const opened = OPEN[kind].exec(line);
      if (opened !== null) { open.push({ kind, line: i, indent: opened[1] ?? '' }); return; }
      if (CLOSE[kind].test(line) && open.at(-1)?.kind === kind) {
        const o = open.pop() as { kind: Kind; line: number; indent: string };
        blocks.set(o.line, { kind, close: i, indent: o.indent });
        return;
      }
    }
  });
  return blocks;
}

/**
 * A callout (`<aside>`) becomes a quote whose first line of text is bold, the emoji kept inside the bold (Q37 = A); a toggle (`<details><summary>`) becomes its summary as a bold
 * paragraph followed by its content (Q38 = A). A block that is not closed, and anything inside a code fence, is left as it is.
 */
export function convertConstructs(markdown: string): string {
  const lines = markdown.split('\n');
  const blocks = matchBlocks(lines);
  if (blocks.size === 0) return markdown;
  const closes = new Map([...blocks.values()].map((b) => [b.close, b]));
  const out: string[] = [];
  const frames: { kind: Kind; indent: string; from: number; first: boolean }[] = [];
  lines.forEach((line, i) => {
    const block = blocks.get(i);
    if (block !== undefined) { frames.push({ kind: block.kind, indent: block.indent, from: out.length, first: true }); return; }
    if (closes.has(i)) {
      const frame = frames.pop();
      // A callout's last lines that are only quote marks are its blank lines before the close: they go with the close.
      if (frame?.kind === 'aside') while (out.length > frame.from && /^\s*>[\s>]*$/.test(out.at(-1) ?? '')) out.pop();
      return;
    }
    const callouts = frames.filter((f) => f.kind === 'aside');
    const toggle = frames.at(-1)?.kind === 'details' ? frames.at(-1) : undefined;
    const indent = frames[0]?.indent ?? '';
    let content = line.startsWith(indent) ? line.slice(indent.length) : line.trimStart();
    if (toggle?.first === true && content.trim() !== '') {
      toggle.first = false;
      const summary = SUMMARY.exec(content)?.[1];
      if (summary !== undefined) content = `**${summary.trim()}**`;
    } else {
      const callout = callouts.at(-1);
      if (callout?.first === true && content.trim() !== '' && frames.at(-1) === callout) {
        if (!NOT_A_FIRST_LINE.test(content)) { callout.first = false; content = `**${content.trim().replace(/\*\*|__/g, '')}**`; } else if (!/^\s*<[a-zA-Z]/.test(content)) callout.first = false;
      }
    }
    if (callouts.length === 0) { out.push(frames.length === 0 ? line : `${indent}${content}`); return; }
    const marks = Array.from({ length: callouts.length }, () => '>').join(' ');
    out.push(`${indent}${marks}${content.trim() === '' ? '' : ` ${content}`}`);
  });
  return out.join('\n');
}
