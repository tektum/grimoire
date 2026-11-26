import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { splitStalls, startMachineProbe } from './machine-probe.js';

describe('splitStalls', () => {
  it('calls a stall of this process the machine\'s when a probe in another process stood still for most of the same time', () => {
    const own = [{ at: 5_000, epoch: 1_000, ms: 600 }];
    expect(splitStalls(own, [{ at: 1_050, ms: 550 }])).toEqual({ process: [], machine: own });
  });

  it('keeps it as this process\'s when the other probe did not stall, stalled elsewhere, or overlapped for less than half of it', () => {
    const own = [{ at: 5_000, epoch: 1_000, ms: 600 }];
    for (const other of [[], [{ at: 3_000, ms: 700 }], [{ at: 1_500, ms: 400 }]]) expect(splitStalls(own, other), JSON.stringify(other)).toEqual({ process: own, machine: [] });
  });

  it('excuses nothing when there is no other probe to go by (it could not start, or did not answer)', () => {
    const own = [{ at: 5_000, epoch: 1_000, ms: 600 }];
    expect(splitStalls(own, undefined)).toEqual({ process: own, machine: [] });
  });

  it('splits a mixed list stall by stall', () => {
    const a = { at: 1_000, epoch: 10_000, ms: 300 };
    const b = { at: 9_000, epoch: 20_000, ms: 300 };
    expect(splitStalls([a, b], [{ at: 10_000, ms: 300 }])).toEqual({ process: [b], machine: [a] });
  });
});

describe('startMachineProbe', () => {
  it('reports no stall for a process that ran on time, and the stall of a process that was stopped for a quarter of a second', async () => {
    const quiet = startMachineProbe();
    await sleep(100);
    expect(await quiet.stop()).toEqual([]);

    const probe = startMachineProbe();
    const pid = probe.pid;
    if (pid === undefined) throw new Error('the probe did not start');
    await sleep(150);
    process.kill(pid, 'SIGSTOP');
    await sleep(250);
    process.kill(pid, 'SIGCONT');
    await sleep(100);
    const seen = await probe.stop();
    expect(seen).toHaveLength(1);
    expect(seen?.[0]?.ms).toBeGreaterThanOrEqual(200);
  });
});
