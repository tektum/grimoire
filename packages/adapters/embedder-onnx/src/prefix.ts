/** What the e5 models read in front of a text: a search is `query: `, a page's text is `passage: `. They were trained so, and the same text without it embeds differently. */
const PREFIX = { query: 'query: ', passage: 'passage: ' } as const;

export type TextKind = keyof typeof PREFIX;

/** The text as the model is to read it. The callers of the port pass the plain text; the prefix is the adapter's business. */
export const prefixed = (kind: TextKind, text: string): string => PREFIX[kind] + text;
