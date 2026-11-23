// The small part of the Hocuspocus wire format the scripted server needs. Every message is: a document name (a varint length and UTF-8 bytes),
// a message type (varint), then the body. Authentication is type 2: its body is a subtype (0 = token from the client, 1 = permission denied,
// 2 = authenticated) and a string. Stateless is type 5 with one string. Numbers are LEB128 varints, as in the lib0 encoder the provider uses.

export const MessageType = { Sync: 0, Awareness: 1, Auth: 2, QueryAwareness: 3, Stateless: 5 } as const;
export const AuthType = { Token: 0, PermissionDenied: 1, Authenticated: 2 } as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function writeVarUint(out: number[], value: number): void {
  let n = value;
  while (n > 0x7f) {
    out.push(0x80 | (n & 0x7f));
    n = Math.floor(n / 128);
  }
  out.push(n);
}
export function writeVarString(out: number[], value: string): void {
  const bytes = encoder.encode(value);
  writeVarUint(out, bytes.length);
  for (const b of bytes) out.push(b);
}

/** A reader over one message; it throws a plain error when the bytes end early, so a malformed frame never loops. */
export class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  varUint(): number {
    let result = 0;
    let scale = 1;
    for (;;) {
      const byte = this.bytes[this.at++];
      if (byte === undefined) throw new Error('message ends inside a number');
      result += (byte & 0x7f) * scale;
      if (byte < 0x80) return result;
      scale *= 128;
    }
  }
  varString(): string {
    const length = this.varUint();
    if (this.at + length > this.bytes.length) throw new Error('message ends inside a string');
    const text = decoder.decode(this.bytes.subarray(this.at, this.at + length));
    this.at += length;
    return text;
  }
}

const frame = (build: (out: number[]) => void): Uint8Array<ArrayBuffer> => {
  const out: number[] = [];
  build(out);
  return Uint8Array.from(out);
};

/** What a client sends first: the token for a document. */
export const authMessage = (document: string, token: string): Uint8Array<ArrayBuffer> =>
  frame((o) => {
    writeVarString(o, document);
    writeVarUint(o, MessageType.Auth);
    writeVarUint(o, AuthType.Token);
    writeVarString(o, token);
  });
/** What the server answers when it accepts the token. */
export const authenticatedMessage = (document: string, scope = 'read-write'): Uint8Array<ArrayBuffer> =>
  frame((o) => {
    writeVarString(o, document);
    writeVarUint(o, MessageType.Auth);
    writeVarUint(o, AuthType.Authenticated);
    writeVarString(o, scope);
  });
export const permissionDeniedMessage = (document: string, reason: string): Uint8Array<ArrayBuffer> =>
  frame((o) => {
    writeVarString(o, document);
    writeVarUint(o, MessageType.Auth);
    writeVarUint(o, AuthType.PermissionDenied);
    writeVarString(o, reason);
  });
export const statelessMessage = (document: string, payload: string): Uint8Array<ArrayBuffer> =>
  frame((o) => {
    writeVarString(o, document);
    writeVarUint(o, MessageType.Stateless);
    writeVarString(o, payload);
  });

export type ParsedMessage = { document: string; kind: 'auth-token'; token: string } | { document: string; kind: 'stateless'; payload: string } | { document: string; kind: 'other'; type: number };

/** Reads the messages the scripted server cares about; any other message is `other`. A malformed one throws. */
export function parseMessage(bytes: Uint8Array): ParsedMessage {
  const reader = new Reader(bytes);
  const document = reader.varString();
  const type = reader.varUint();
  if (type === MessageType.Auth && reader.varUint() === AuthType.Token) return { document, kind: 'auth-token', token: reader.varString() };
  if (type === MessageType.Stateless) return { document, kind: 'stateless', payload: reader.varString() };
  return { document, kind: 'other', type };
}
