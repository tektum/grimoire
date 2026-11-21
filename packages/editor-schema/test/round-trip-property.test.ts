import { schemaCtx } from "@milkdown/core";
import type { Node } from "@milkdown/prose/model";
import { describe, expect, it } from "vitest";
import { document, type Json } from "./generate.js";
import { makeEditor } from "./helpers.js";
import { para, text } from "./build.js";
import { normaliseForMarkdown } from "../src/index.js";

/** The document as plain data, list `spread` aside (written loose or tight, it reads back with the matching flag). */
function plain(node: Node): unknown {
  const json = node.toJSON() as { attrs?: Record<string, unknown> };
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "spread");
      return Object.fromEntries(entries.map(([key, inner]) => [key, strip(inner)]));
    }
    return value;
  };
  return strip(json);
}

/** Does the document contain `inner` somewhere below a `outer` node? */
function contains(node: Json, outer: string, inner: (n: Json) => boolean, inside = false): boolean {
  const now = inside || node.type === outer;
  if (now && node !== undefined && inner(node) && node.type !== outer) return true;
  return (node.content ?? []).some((child) => contains(child, outer, inner, now));
}

/**
 * Known classes of failure (docs/proof/m2-schema-fixes.md, known limits). Anything else is a new failure.
 * Known weakness: the label is chosen for the whole document (the first documented construct found), not per loss, so a document that
 * contains a documented construct can hide an unrelated loss in the same document. Documents without any documented construct are
 * checked strictly (they land in "unclassified"). A per-loss classifier would be a redesign of this test.
 */
function classify(json: Json, kind: string): string {
  const inQuote = (types: string[]) => contains(json, "blockquote", (n) => types.includes(n.type));
  if (kind === "drift" && inQuote(["bullet_list", "ordered_list"])) return "blank lines between list items in a quote change on the second save";
  if (kind === "drift" && anyNode(json, (n) => n.type === "list_item" && anyNode(n, (m) => m.type === "table"))) return "a table inside a list item";
  if (anyNode(json, (n) => n.type === "text" && !(n.marks ?? []).some((m) => m.type === "link") && /https?:\/\/|www\.|[\w.+-]+@[\w-]+\.\w/.test(n.text ?? ""))) return "text that looks like a web or email address is read back as a link";
  if (anyNode(json, (n) => n.type === "list_item" && n.attrs?.["checked"] !== null && (n.content?.[0]?.attrs?.["level"] ?? 0) !== 0)) return "a task checkbox in front of a heading is lost";
  if (kind === "drift" && anyNode(json, (n) => n.type === "table" && anyNode(n, (m) => (m.text ?? "").includes("\t")))) return "a tab inside a table cell changes the column padding";
  if (anyNode(json, (n) => n.type === "table" && anyNode(n, (m) => (m.marks ?? []).some((mark) => mark.type === "inlineCode") && (m.text ?? "").includes("\\|")))) return "inline code with a backslash before a pipe in a table cell";
  return "unclassified";
}

const anyNode = (node: Json, test: (n: Json) => boolean): boolean => test(node) || (node.content ?? []).some((child) => anyNode(child, test));

/** How many children a container holds: the tokens have no closing markers, so this is what tells `quote[a, b]` from `quote[a], b`. */
const shapeOf = (node: Node): string => (node.isTextblock || node.isLeaf ? "" : `#${node.childCount}`);
const marksOf = (node: Node): string => node.marks.map((m) => `${m.type.name}${JSON.stringify(m.attrs)}`).sort().join("+");

/** Characters and non-text nodes with marks, whitespace characters kept apart (a tab is not a space) but without marks: the document as a reader sees it, ignoring which marks cover a space. */
function tokens(node: Node): string[] {
  const out: string[] = [`<${node.type.name}${JSON.stringify(node.attrs)}${shapeOf(node)}${marksOf(node)}`]; // descendants() skips the node itself
  node.descendants((child) => {
    if (child.isText) for (const char of child.text ?? "") out.push(/\s/.test(char) ? char : `${char}${marksOf(child)}`);
    else out.push(`<${child.type.name}${JSON.stringify(child.attrs)}${shapeOf(child)}${marksOf(child)}`);
  });
  return out;
}

const SPACES = "which marks cover a space at the edge of a marked run";
const noSpread = (list: string[]): string => JSON.stringify(list.map((t) => t.replaceAll('"spread":true', '"spread":false')));
const blocks = (node: Node): Node[] => {
  const out: Node[] = [];
  node.forEach((child) => void out.push(child));
  return out;
};

/**
 * What explains a document that did not read back the same. With the same number of top-level blocks, every block that changed is
 * explained on its own, so a documented construct in one block cannot hide a different loss in another. If the block count changed
 * (blocks merged or split), the document as a whole is explained, as a last resort.
 */
function verdictsFor(before: Node, after: Node, json: Json, kind: string): { label: string; spaces: boolean }[] {
  const was = blocks(before);
  const now = blocks(after);
  if (was.length !== now.length) {
    const same = noSpread(tokens(before)) === noSpread(tokens(after));
    return [same ? { label: SPACES, spaces: true } : { label: classify(json, kind), spaces: false }];
  }
  const out: { label: string; spaces: boolean }[] = [];
  was.forEach((block, i) => {
    const other = now[i] as Node;
    if (JSON.stringify(plain(block)) === JSON.stringify(plain(other))) return;
    out.push(noSpread(tokens(block)) === noSpread(tokens(other)) ? { label: SPACES, spaces: true } : { label: classify(block.toJSON() as Json, kind), spaces: false });
  });
  return out;
}

/** What explains a second save that differs: each block that drifts on its own, or the whole document if none does alone. */
function driftVerdicts(json: Json, drifting: Json[]): { label: string; spaces: boolean }[] {
  if (drifting.length === 0) return [{ label: classify(json, "drift"), spaces: false }];
  return drifting.map((block) => ({ label: classify(block, "drift"), spaces: false }));
}

const COUNT = 2000;

interface Report {
  documents: number;
  fixedPoints: number;
  losses: Map<string, number>;
  drift: Map<string, number>;
  spaces: Map<string, number>;
  unclassified: unknown[];
  notNormalForm: number;
  notIdempotent: number;
}

async function run(mode: "tame" | "wild" | "addresses" | "html"): Promise<Report> {
  const editor = await makeEditor({ markdown: "x\n" });
  const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
  const report: Report = { documents: COUNT, fixedPoints: 0, losses: new Map(), drift: new Map(), spaces: new Map(), unclassified: [], notNormalForm: 0, notIdempotent: 0 };
  const bump = (map: Map<string, number>, label: string): void => void map.set(label, (map.get(label) ?? 0) + 1);
  for (let seed = 0; seed < COUNT; seed++) {
    const json = document(seed, mode);
    const doc = schema.nodeFromJSON(json);
    doc.check();
    const normal = normaliseForMarkdown(doc);
    const md = editor.serialize(doc);
    if (editor.serialize(normal) !== md) report.notNormalForm++;
    if (JSON.stringify(normaliseForMarkdown(normal).toJSON()) !== JSON.stringify(normal.toJSON())) report.notIdempotent++;
    const again = editor.parse(md);
    const sameDocument = JSON.stringify(plain(normal)) === JSON.stringify(plain(again));
    const stable = editor.serialize(again) === md;
    if (sameDocument && stable) {
      report.fixedPoints++;
      continue;
    }
    const kind = sameDocument ? "drift" : "document";
    const drifting = (): Json[] =>
      blocks(normal)
        .filter((block) => {
          const written = editor.serialize(schema.topNodeType.create(null, [block]));
          return editor.serialize(editor.parse(written)) !== written;
        })
        .map((block) => block.toJSON() as Json);
    const verdicts = sameDocument ? driftVerdicts(json, drifting()) : verdictsFor(normal, again, json, kind);
    if (verdicts.length === 0 || verdicts.some((v) => v.label === "unclassified")) {
      report.unclassified.push({ seed, md, kind, before: JSON.stringify(plain(normal)), after: sameDocument ? JSON.stringify(editor.serialize(again)) : JSON.stringify(plain(again)) });
      continue;
    }
    for (const v of new Set(verdicts.map((x) => JSON.stringify(x)))) {
      const { label, spaces } = JSON.parse(v) as { label: string; spaces: boolean };
      bump(spaces ? report.spaces : sameDocument ? report.drift : report.losses, label);
    }
  }
  process.stdout.write(`\nproperty ${mode}: ${report.fixedPoints} of ${COUNT} full fixed points; losses ${JSON.stringify([...report.losses])}; drift ${JSON.stringify([...report.drift])}; spaces ${JSON.stringify([...report.spaces])}\n`);
  const first = report.unclassified[0] as { seed: number; md: string; before: string; after: string } | undefined;
  if (first) {
    let at = 0;
    while (first.before[at] === first.after[at] && at < first.before.length) at++;
    process.stdout.write(`unclassified ${mode} ${first.seed}: ${JSON.stringify(first.md).slice(0, 300)}\n  A ${first.before.slice(Math.max(0, at - 80), at + 120)}\n  B ${first.after.slice(Math.max(0, at - 80), at + 120)}\n`);
  }
  return report;
}

describe("the classifier of the property test explains each changed block on its own", () => {
  const nodes = async (...blocks: Json[]): Promise<Node> => {
    const editor = await makeEditor({ markdown: "x\n" });
    return editor.editor.action((ctx) => ctx.get(schemaCtx)).nodeFromJSON({ type: "doc", content: blocks });
  };

  it("a documented loss in one block does not hide a different loss in another", async () => {
    const link = { type: "link", attrs: { href: "http://a.example", title: null } };
    const written = await nodes(para(0, text("http://a.example")), para(0, text("kept")));
    const readOnlyLink = await nodes(para(0, { type: "text", text: "http://a.example", marks: [link] }), para(0, text("kept")));
    const alsoLost = await nodes(para(0, { type: "text", text: "http://a.example", marks: [link] }), para(0, text("lost")));
    const json = written.toJSON() as Json;
    expect(verdictsFor(written, readOnlyLink, json, "document").map((v) => v.label)).toEqual(["text that looks like a web or email address is read back as a link"]);
    expect(verdictsFor(written, alsoLost, json, "document").map((v) => v.label)).toEqual(["text that looks like a web or email address is read back as a link", "unclassified"]);
  });

  it("a block that came back as another kind of block is a loss, even when its text is the same", async () => {
    const heading = await nodes(para(2, text("same")));
    const paragraph = await nodes(para(0, text("same")));
    expect(verdictsFor(heading, paragraph, heading.toJSON() as Json, "document").map((v) => v.label)).toEqual(["unclassified"]);
  });

  it("a quote that lost a child to the level above is a loss, not a difference in marks over a space", async () => {
    const together = await nodes({ type: "blockquote", content: [para(0, text("a")), para(0, text("b"))] });
    const split = await nodes({ type: "blockquote", content: [para(0, text("a"))] }, para(0, text("b")));
    expect(verdictsFor(together, split, together.toJSON() as Json, "document").map((v) => v.label)).toEqual(["unclassified"]);
  });

  it("a second save that drifts is explained block by block: an address in another block does not explain it", () => {
    const address = para(0, text("see http://a.example"));
    const table: Json = { type: "table", content: [{ type: "table_header_row", content: [] }] };
    const json: Json = { type: "doc", content: [address, table] };
    expect(driftVerdicts(json, [table]).map((v) => v.label)).toEqual(["unclassified"]);
    expect(driftVerdicts(json, []).map((v) => v.label)).toEqual(["text that looks like a web or email address is read back as a link"]);
  });

  it("a tab that became a space is a loss, not a difference in marks over a space", async () => {
    const tab = await nodes(para(0, text("a\tb")));
    const space = await nodes(para(0, text("a b")));
    expect(verdictsFor(tab, space, tab.toJSON() as Json, "document").map((v) => v.label)).toEqual(["unclassified"]);
  });
});

describe("document -> Markdown -> document, and Markdown -> document -> Markdown", () => {
  it(`${COUNT} generated documents: the three statements hold, every failure is a documented class`, async () => {
    const report = await run("tame");
    expect(report.notNormalForm).toBe(0);
    expect(report.notIdempotent).toBe(0);
    expect(report.unclassified).toEqual([]);
    expect(report.fixedPoints).toBeGreaterThan(COUNT * 0.97);
  }, 600_000);

  it(`${COUNT} wild documents (inline code beside text, task headings, hard breaks in cells): the same`, async () => {
    const report = await run("wild");
    expect(report.notNormalForm).toBe(0);
    expect(report.notIdempotent).toBe(0);
    expect(report.unclassified).toEqual([]);
  }, 600_000);

  it(`${COUNT} documents with web and email addresses in text (read back as links, a documented class): the same`, async () => {
    const report = await run("addresses");
    expect(report.notNormalForm).toBe(0);
    expect(report.notIdempotent).toBe(0);
    expect(report.unclassified).toEqual([]);
  }, 600_000);

  it(`${COUNT} html-heavy documents (all seven HTML block start conditions, whole elements, padded and doubled breaks): the same`, async () => {
    const report = await run("html");
    expect(report.notNormalForm).toBe(0);
    expect(report.notIdempotent).toBe(0);
    expect(report.unclassified).toEqual([]);
  }, 600_000);
});
