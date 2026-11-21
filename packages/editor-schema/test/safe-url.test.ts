import { schemaCtx } from "@milkdown/core";
import { DOMSerializer, type Node } from "@milkdown/prose/model";
import { describe, expect, it } from "vitest";
import { isSafeUrl, normaliseForMarkdown } from "../src/index.js";
import { seeded } from "./generate.js";
import { makeEditor } from "./helpers.js";

/** 60 spellings of an address that runs script or loads active content, as a browser would read them. */
const HOSTILE: string[] = [
  "javascript:alert(1)", "JavaScript:alert(1)", "JAVASCRIPT:alert(1)", "jAvAsCrIpT:alert(1)", " javascript:alert(1)", "javascript:alert(1) ",
  "\tjavascript:alert(1)", "\njavascript:alert(1)", "\rjavascript:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)", "java\rscript:alert(1)",
  "jav\tascript:alert(1)", "javascript\t:alert(1)", "javascript:\talert(1)", "\u0000javascript:alert(1)", "\u0001javascript:alert(1)", "\u001fjavascript:alert(1)",
  "\u007fjavascript:alert(1)", "\u0085javascript:alert(1)", "\u00a0javascript:alert(1)", "\u2028javascript:alert(1)", "\u200bjavascript:alert(1)", "\ufeffjavascript:alert(1)",
  "java\u200bscript:alert(1)", "\u00adjavascript:alert(1)", "\uff4aavascript:alert(1)", "javascript&#58;alert(1)", "&#106;avascript:alert(1)", "&#x6A;avascript:alert(1)",
  "javascript&colon;alert(1)", "java&Tab;script:alert(1)", "java&NewLine;script:alert(1)", "%6Aavascript:alert(1)", "%6aavascript:alert(1)", "javascript%3Aalert(1)",
  "javascript%3aalert(1)", "%09javascript:alert(1)", "java%09script:alert(1)", "%20javascript:alert(1)", "vbscript:msgbox(1)", "VBScript:msgbox(1)",
  " vbscript:msgbox(1)", "vb\tscript:msgbox(1)", "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==", "DATA:text/html,<script>alert(1)</script>", "data:image/svg+xml,<svg onload=alert(1)>", " data:text/html,x",
  "da\tta:text/html,x", "data:application/javascript,alert(1)", "file:///etc/passwd", "FILE:///etc/passwd", "blob:https://example.com/1",
  "about:blank", "chrome://settings", "jar:https://example.com/x.jar!/", "ws://example.com", "livescript:alert(1)", "mocha:alert(1)",
  "x-javascript:alert(1)", "javascript:/*http://ok*/alert(1)", "http\t:alert(1)", "J\u0061vascript:alert(1)", `javascript:${"a".repeat(100)}`, `https://example.com/${"a".repeat(9000)}`,
];

const marks = (href: string): unknown[] => [{ type: "link", attrs: { href, title: null, nest: "inner" } }];
const paragraph = (...content: unknown[]): unknown => ({ type: "paragraph", attrs: { level: 0 }, content });
const image = (src: string, href = ""): unknown => ({ type: "image", attrs: { src, alt: "pic", title: "", href, linkTitle: "" } });

function linkHrefs(doc: Node): string[] {
  const found: string[] = [];
  doc.descendants((node) => {
    for (const mark of node.marks) if (mark.type.name === "link") found.push(String(mark.attrs["href"]));
    if (node.type.name === "image" && node.attrs["href"]) found.push(String(node.attrs["href"]));
  });
  return found;
}
function imageSrcs(doc: Node): string[] {
  const found: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "image") found.push(String(node.attrs["src"]));
  });
  return found;
}

describe("isSafeUrl", () => {
  it("has 60 hostile spellings", () => {
    expect(HOSTILE.length).toBeGreaterThanOrEqual(60);
  });

  it.each(HOSTILE.map((url, index) => [index, url] as const))("hostile spelling %i is refused, as a link and as an image", (_index, url) => {
    expect(isSafeUrl(url)).toBe(false);
    expect(isSafeUrl(url, "image")).toBe(false);
  });

  it.each(["tel:+15551234", "sms:+15551234", "xmpp:discuss@example.org?join", "irc://irc.example.org/chan", "ftp://example.com/x", "geo:37.786971,-122.399677", "https://example.com/a?b=c#d", "http://example.com", "HTTPS://EXAMPLE.COM/", "mailto:someone@example.com", "/relative/path", "relative/path.md", "./a", "../a", "#fragment", "?query=1", "//cdn.example.com/x", "page with spaces.md", "a/b:c", "https://example.com/a%20b", "https://example.com/?q=a%0Ab", "https://例え.jp/パス", "files/10:30.pdf", ""])("allows %j as a link", (url) => {
    expect(isSafeUrl(url)).toBe(true);
  });

  it("allows mailto and the hand-over schemes only for links, not for images", () => {
    expect(isSafeUrl("mailto:a@b.c")).toBe(true);
    expect(isSafeUrl("mailto:a@b.c", "image")).toBe(false);
    expect(isSafeUrl("ftp://example.com/i.png", "image")).toBe(false);
  });

  it("refuses what is not a string", () => {
    for (const value of [undefined, null, 1, {}, ["https://example.com"]]) expect(isSafeUrl(value as unknown as string)).toBe(false);
  });

  it("legitimate addresses with unusual characters still pass (2,000 seeded)", () => {
    const next = seeded(20_260_101);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const schemes = ["http://", "https://", "//", "/", "./", "../", "#", "?", ""];
    const chars = ["a", "Z", "0", "-", "_", ".", "~", "%41", "%20", "%E3%81%82", "+", "=", "&", ";", ",", "@", "!", "$", "'", "(", ")", "*", "[", "]", "あ", "é", "ü", "😀", " ", "/", "?", "#"];
    for (let i = 0; i < 2_000; i++) {
      // A colon only after a slash, a question mark or a hash keeps the first segment free of a scheme.
      const body = Array.from({ length: 1 + Math.floor(next() * 12) }, () => pick(chars)).join("").replace(/^:+/, "");
      const url = `${pick(schemes)}${body}`.trim(); // leading and trailing spaces are refused on purpose
      if (/^[^/?#]*:/.test(url) && !/^https?:/i.test(url)) continue;
      expect(isSafeUrl(url), url).toBe(true);
    }
  });
});

describe("a refused address is inert in the document, in the DOM and in the stored Markdown", () => {
  it.each(HOSTILE.map((url, index) => [index, url] as const))("hostile spelling %i", async (_index, url) => {
    const editor = await makeEditor({ markdown: "x\n" });
    const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
    const live = schema.nodeFromJSON({ type: "doc", content: [paragraph({ type: "text", text: "link", marks: marks(url) }, image(url), image("https://example.com/ok.png", url))] });

    // DOM: the live document, with the hostile attributes in it, renders no active address.
    const container = document.createElement("div");
    container.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(live.content));
    for (const element of Array.from(container.querySelectorAll("[href],[src]"))) {
      for (const name of ["href", "src"]) {
        const value = element.getAttribute(name);
        if (value !== null) expect(isSafeUrl(value, element.tagName === "IMG" ? "image" : "link"), `${name}=${JSON.stringify(value)}`).toBe(true);
      }
    }
    // The hostile spelling itself is in no attribute of the rendered DOM (exact, not a search for part of it).
    const rendered = Array.from(container.querySelectorAll("[href],[src]")).flatMap((element) => ["href", "src"].map((name) => element.getAttribute(name)));
    expect(rendered).not.toContain(url);

    // Document and Markdown: the normal form drops the link, keeps the text, and the saved Markdown holds none of it.
    const normal = normaliseForMarkdown(live);
    expect(linkHrefs(normal).filter((href) => !isSafeUrl(href))).toEqual([]);
    expect(imageSrcs(normal).filter((src) => !isSafeUrl(src, "image"))).toEqual([]);
    expect(normal.textContent).toContain("link");
    const markdown = editor.serialize(live);
    expect(markdown).toBe(editor.serialize(normal));
    expect(markdown).not.toContain(url.trim());
    const read = editor.parse(markdown);
    expect(linkHrefs(read).filter((href) => !isSafeUrl(href))).toEqual([]);
  });

  it.each(HOSTILE.slice(0, 36).filter((url) => !/[\u0000-\u001f\u007f<>]/.test(url) && url.trim() === url && !url.includes(" ")).map((url) => [url] as const))("read from Markdown: %s", async (url) => {
    const editor = await makeEditor({ markdown: "x\n" });
    const source = `[text](<${url}>) ![alt](<${url}>) [![alt](<https://example.com/ok.png>)](<${url}>)\n`;
    const doc = editor.parse(source);
    expect(linkHrefs(doc).filter((href) => !isSafeUrl(href))).toEqual([]);
    expect(imageSrcs(doc).filter((src) => !isSafeUrl(src, "image"))).toEqual([]);
    expect(doc.textContent).toContain("text");
    expect(editor.serialize(doc)).not.toContain(url);
  });

  it("what a refused address becomes: a link keeps its text and loses the link; an image becomes its alt text; an image link keeps the image", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const doc = editor.parse("[text](javascript:alert(1)) and ![the alt](data:text/html;base64,AAAA) and [![pic](https://example.com/p.png)](vbscript:x)\n");
    expect(editor.serialize(doc)).toBe("text and the alt and ![pic](https://example.com/p.png)\n");
  });

  it("an image with nothing to show (no alt text) is dropped, not kept live", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    expect(editor.serialize(editor.parse("before ![](javascript:alert(1)) after\n"))).toBe("before  after\n");
  });

  it("reference-style and autolink spellings are refused too", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const doc = editor.parse("[a][r] <javascript:alert(1)>\n\n[r]: javascript:alert(2)\n");
    expect(linkHrefs(doc)).toEqual([]);
  });
});
