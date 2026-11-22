// A stand-in for a test runner: starts a server child through the helper, prints the child's pid and then stays alive (the child process keeps its event loop running) until it is killed.
import { ServerProcess } from '../src/harness.ts';

const server = new ServerProcess([new URL('./server-start.mjs', import.meta.url).pathname], {}, Number(process.argv[2]));
if (process.argv[3] === 'die-at-once') { process.stdout.write(`child ${String(server.child.pid)}\n`); process.kill(process.pid, 'SIGKILL'); }
await server.waitForEvent('http.listening');
process.stdout.write(`child ${String(server.child.pid)}\n`);
