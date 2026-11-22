// Preload for every child process a test starts: `node --import PARENT_WATCH ...`. The child kills itself when its parent is gone, for any reason
// (the runner was killed, crashed or timed out): a child whose parent died is re-parented, so its parent pid changes. Without this, an interrupted run
// leaves servers behind that hold ports and processor time for hours.
import process from 'node:process';

// The parent names itself in the environment: a parent that dies before this file runs has already been replaced by the reaper, so reading
// `process.ppid` here would record the reaper as the parent.
const parent = Number(process.env['GRIMOIRE_TEST_PARENT_PID']);
// The poll interval can be stretched by a test that must tell the load-time check from the poll.
const POLL_MS = Number(process.env['GRIMOIRE_TEST_PARENT_POLL_MS']) || 250;
const gone = () => Number.isInteger(parent) && process.ppid !== parent;
if (gone()) process.kill(process.pid, 'SIGKILL');
const timer = setInterval(() => { if (gone()) process.kill(process.pid, 'SIGKILL'); }, POLL_MS);
timer.unref();
