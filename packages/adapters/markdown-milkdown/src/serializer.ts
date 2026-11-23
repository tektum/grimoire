import { serializerMatchError } from '@milkdown/exception';
import { SerializerState as UpstreamSerializerState, Stack, StackElement } from '@milkdown/transformer';
import type { JSONRecord, MarkdownNode } from '@milkdown/transformer';

/**
 * A copy of `SerializerState` of `@milkdown/transformer` 7.23.0 (`src/serializer/state.ts`) with ONE change, `#maybeMergeChildren`: upstream copies the
 * array of children for every child it visits (`concat`, `slice`, a spread), so a paragraph of n runs costs time with the square of n (17 s for 80,000 runs
 * of text with edge spaces around marks). This one builds the result in place, and merges a run of equal marks into one node before it reduces that node's
 * children, so the work is linear. Everything else is upstream's code, so the Markdown is byte for byte the same: `test/convert/serializer-copy.test.ts` writes
 * the corpus and random documents with both and compares, and fails loudly when the installed `@milkdown/transformer` is not the version this copy was made from.
 */
export const COPIED_FROM = '@milkdown/transformer@7.23.0';

type Schema = UpstreamSerializerState['schema'];
type ProseNode = Parameters<UpstreamSerializerState['run']>[0];
type Nodes = Parameters<UpstreamSerializerState['next']>[0];
type ProseMark = Parameters<UpstreamSerializerState['closeMark']>[0];
type Remark = Parameters<UpstreamSerializerState['toString']>[0];
type Serializer = ReturnType<typeof UpstreamSerializerState.create>;
type Spec = { toMarkdown: { match: (x: unknown) => boolean; runner: (state: SerializerState, ...rest: unknown[]) => unknown } };
type Target = { spec: Spec };

class SerializerStackElement extends StackElement<MarkdownNode> {
  constructor(
    public type: string,
    public children?: MarkdownNode[],
    public value?: string,
    public props: JSONRecord = {},
  ) {
    super();
  }

  static create = (type: string, children?: MarkdownNode[], value?: string, props: JSONRecord = {}): SerializerStackElement => new SerializerStackElement(type, children, value, props);

  push = (node: MarkdownNode, ...rest: MarkdownNode[]): void => {
    this.children ??= [];
    this.children.push(node, ...rest);
  };

  pop = (): MarkdownNode | undefined => this.children?.pop();
}

const isFragment = (x: Nodes): boolean => Object.prototype.hasOwnProperty.call(x, 'size');

interface Marked extends MarkdownNode { isMark?: boolean; children?: MarkdownNode[] }

export class SerializerState extends Stack<MarkdownNode, SerializerStackElement> {
  readonly schema: Schema;
  #openMarks: { mark: ProseMark; spanning: boolean }[] = [];

  static create = (schema: Schema, remark: Remark): Serializer => {
    const state = new SerializerState(schema);
    return (content: ProseNode) => {
      state.run(content);
      return state.toString(remark);
    };
  };

  constructor(schema: Schema) {
    super();
    this.schema = schema;
  }

  #matchTarget = (node: { type: unknown }): Target => {
    const result = (Object.values({ ...this.schema.nodes, ...this.schema.marks }) as unknown as Target[]).find((x) => x.spec.toMarkdown.match(node));
    if (!result) throw serializerMatchError((node as { type: never }).type);
    return result;
  };

  #runProseNode = (node: ProseNode): unknown => this.#matchTarget(node).spec.toMarkdown.runner(this, node);

  #runProseMark = (mark: ProseMark, node: ProseNode): unknown => this.#matchTarget(mark).spec.toMarkdown.runner(this, mark, node);

  #orderMarks = (marks: readonly ProseMark[]): ProseMark[] => {
    const getPriority = (x: ProseMark): number => (x.type.spec as { priority?: number }).priority ?? 50;
    const rest = [...marks].sort((a, b) => getPriority(a) - getPriority(b));
    const continuing: ProseMark[] = [];
    this.#openMarks.forEach(({ mark }) => {
      const index = rest.findIndex((x) => x.eq(mark));
      if (index >= 0) continuing.push(...rest.splice(index, 1));
    });
    return continuing.concat(rest);
  };

  #closeEndedMarks = (next?: ProseNode): void => {
    const nextMarks = next?.marks;
    let keep = 0;
    while (keep < this.#openMarks.length) {
      const { mark, spanning } = this.#openMarks[keep] as { mark: ProseMark; spanning: boolean };
      if (spanning && nextMarks?.some((x) => x.eq(mark))) keep++;
      else break;
    }
    for (let i = this.#openMarks.length - 1; i >= keep; i--) this.#closeMark((this.#openMarks[i] as { mark: ProseMark }).mark);
  };

  #runNode = (node: ProseNode, next?: ProseNode): void => {
    if (this.#orderMarks(node.marks).every((mark) => !this.#runProseMark(mark, node))) this.#runProseNode(node);
    this.#closeEndedMarks(next);
  };

  /** The one change from upstream: see the comment of the file. */
  #maybeMergeChildren = (node: MarkdownNode): MarkdownNode => {
    const { children } = node as Marked;
    if (!children) return node;
    const result: MarkdownNode[] = [];
    // Nodes made here by merging; their children are reduced once, after the run of equal marks is complete.
    const made = new Set<MarkdownNode>();
    for (let index = 0; index < children.length; index++) {
      const child = children[index] as Marked;
      if (index === 0) {
        result.push(child);
        continue;
      }
      const last = result[result.length - 1] as Marked | undefined;
      if (last && last.isMark && child.isMark) {
        const { children: currChildren, ...currRest } = child;
        const { children: prevChildren, ...prevRest } = last;
        if (child.type === last.type && currChildren && prevChildren && JSON.stringify(currRest) === JSON.stringify(prevRest)) {
          if (made.has(last)) {
            // A loop, not `push(...currChildren)`: a spread passes every child as an argument, and V8 refuses a call with a few hundred thousand of them.
            for (const grandchild of currChildren) prevChildren.push(grandchild);
          } else {
            const combined: Marked = { ...prevRest, children: [...prevChildren, ...currChildren] };
            made.add(combined);
            result[result.length - 1] = combined;
          }
          continue;
        }
      }
      result.push(child);
    }
    for (const combined of made) this.#maybeMergeChildren(combined);
    (node as Marked).children = result;
    return node;
  };

  #createMarkdownNode = (element: SerializerStackElement): MarkdownNode => {
    const node: Marked = { ...element.props, type: element.type };
    if (element.children) node.children = element.children;
    if (element.value) node.value = element.value;
    return node;
  };

  #moveSpaces = (element: SerializerStackElement, onPush: () => MarkdownNode): MarkdownNode => {
    let startSpaces = '';
    let endSpaces = '';
    const children = element.children;
    if (children) {
      const firstChild = children[0];
      const lastChild = children.at(-1);
      if (lastChild && lastChild.type === 'text' && (lastChild.value as string).endsWith(' ')) {
        const text = lastChild.value as string;
        const trimmed = text.trimEnd();
        endSpaces = text.slice(trimmed.length);
        lastChild.value = trimmed;
      }
      if (firstChild && firstChild.type === 'text' && (firstChild.value as string).startsWith(' ')) {
        const text = firstChild.value as string;
        const trimmed = text.trimStart();
        startSpaces = text.slice(0, text.length - trimmed.length);
        firstChild.value = trimmed;
      }
    }
    if (startSpaces.length) this.#addNodeAndPush('text', undefined, startSpaces);
    const result = onPush();
    if (endSpaces.length) this.#addNodeAndPush('text', undefined, endSpaces);
    return result;
  };

  #closeNodeAndPush = (trim = false): MarkdownNode => {
    const element = this.close();
    const onPush = (): MarkdownNode => this.#addNodeAndPush(element.type, element.children, element.value, element.props);
    if (trim) return this.#moveSpaces(element, onPush);
    return onPush();
  };

  #addNodeAndPush = (type: string, children?: MarkdownNode[], value?: string, props?: JSONRecord): MarkdownNode => {
    const element = SerializerStackElement.create(type, children, value, props);
    const node = this.#maybeMergeChildren(this.#createMarkdownNode(element));
    this.push(node);
    return node;
  };

  #openMark = (mark: ProseMark, type: string, value?: string, props?: JSONRecord): this => {
    if (this.#openMarks.some((x) => x.mark.eq(mark))) return this;
    this.#openMarks.push({ mark, spanning: value == null });
    return this.openNode(type, value, { ...props, isMark: true });
  };

  #closeMark = (mark: ProseMark): void => {
    let index = -1;
    for (let i = this.#openMarks.length - 1; i >= 0; i--) {
      if ((this.#openMarks[i] as { mark: ProseMark }).mark.eq(mark)) {
        index = i;
        break;
      }
    }
    if (index < 0) return;
    this.#openMarks.splice(index, 1);
    this.#closeNodeAndPush(true);
  };

  openNode = (type: string, value?: string, props?: JSONRecord): this => {
    this.open(SerializerStackElement.create(type, undefined, value, props));
    return this;
  };

  closeNode = (): this => {
    this.#closeNodeAndPush();
    return this;
  };

  addNode = (type: string, children?: MarkdownNode[], value?: string, props?: JSONRecord): this => {
    this.#addNodeAndPush(type, children, value, props);
    return this;
  };

  withMark = (mark: ProseMark, type: string, value?: string, props?: JSONRecord): this => {
    this.#openMark(mark, type, value, props);
    return this;
  };

  closeMark = (mark: ProseMark): this => {
    this.#closeMark(mark);
    return this;
  };

  build = (): MarkdownNode => {
    let doc: Marked;
    do doc = this.#closeNodeAndPush();
    while (this.size());
    if (!doc.children) doc.children = [];
    return doc;
  };

  next = (nodes: Nodes): this => {
    if (isFragment(nodes)) {
      const fragment = nodes as unknown as { forEach: (f: (node: ProseNode, offset: number, index: number) => void) => void; maybeChild: (i: number) => ProseNode | null };
      fragment.forEach((node, _offset, index) => {
        this.#runNode(node, fragment.maybeChild(index + 1) ?? undefined);
      });
      return this;
    }
    this.#runNode(nodes as ProseNode);
    return this;
  };

  override toString = (remark: Remark): string => remark.stringify(this.build() as unknown as Parameters<Remark['stringify']>[0]);

  run = (tree: ProseNode): this => {
    this.#openMarks = [];
    this.next(tree);
    return this;
  };
}
