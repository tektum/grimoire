import { spawn } from 'node:child_process';

/** A stretch in which a process did not run its timers: when it began (epoch milliseconds) and how long it lasted. */
export interface Stall {
  readonly at: number;
  readonly ms: number;
}

/**
 * What the probe process runs: a 10 ms timer that notes every gap of more than 100 ms, and prints the list as JSON when its input ends. It does nothing else, so a gap in it is not its own work:
 * the machine did not run it (a pause of the virtual machine, or no CPU for a moment).
 */
const PROBE = `
let last = Date.now();
const gaps = [];
setInterval(() => { const now = Date.now(); if (now - last > 110) gaps.push({ at: last, ms: now - last - 10 }); last = now; }, 10);
process.stdin.on('end', () => { process.stdout.write(JSON.stringify(gaps)); process.exit(0); });
process.stdin.resume();
`;

export interface MachineProbe {
  readonly pid: number | undefined;
  /** Ends the probe and gives its stalls; `undefined` when it did not start or did not answer (nothing is then excused). */
  stop(): Promise<readonly Stall[] | undefined>;
}

/** Starts a probe in another process, to tell a stall of the machine from a stall of this process: a pause of the machine stops both, work in this process stops only this one. */
export function startMachineProbe(): MachineProbe {
  const child = spawn(process.execPath, ['-e', PROBE], { stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  const settled = new Promise<readonly Stall[] | undefined>((resolve) => {
    child.on('error', () => { resolve(undefined); });
    child.on('close', () => {
      try {
        const parsed: unknown = JSON.parse(out);
        resolve(Array.isArray(parsed) ? (parsed as Stall[]) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
  return {
    pid: child.pid,
    // The probe exits as soon as its input ends, so there is nothing to wait out: a probe that is stuck is a test that times out, which says so.
    stop() {
      child.stdin.end();
      return settled;
    },
  };
}

const overlap = (aFrom: number, aTo: number, bFrom: number, bTo: number): number => Math.max(0, Math.min(aTo, bTo) - Math.max(aFrom, bFrom));

/**
 * The stalls of this process (each with the epoch time it began) split into those the other probe shared (it stood still for at least half of the time: the machine's) and those it did not (this
 * process's own). With no answer from the probe nothing is excused.
 */
export function splitStalls<T extends { readonly epoch: number; readonly ms: number }>(own: readonly T[], other: readonly Stall[] | undefined): { process: T[]; machine: T[] } {
  const split: { process: T[]; machine: T[] } = { process: [], machine: [] };
  for (const stall of own) {
    const shared = (other ?? []).reduce((sum, o) => sum + overlap(stall.epoch, stall.epoch + stall.ms, o.at, o.at + o.ms), 0);
    (shared >= stall.ms / 2 ? split.machine : split.process).push(stall);
  }
  return split;
}
