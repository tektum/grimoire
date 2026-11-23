export type VersionTriple = [number, number, number];

const triple = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Reads a dotted triple such as `1.2.3`. Anything else, including a part too large to compare exactly, gives null. */
export function parseVersion(text: string): VersionTriple | null {
  const match = triple.exec(text);
  if (match === null) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!parts.every((part) => Number.isSafeInteger(part))) return null;
  return parts as VersionTriple;
}

/** Compares two triples part by part, as numbers. */
export function compareVersions(a: VersionTriple, b: VersionTriple): -1 | 0 | 1 {
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] as number;
    const right = b[i] as number;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}
