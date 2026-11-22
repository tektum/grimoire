// Preloaded into a child process under test (`node --import`): records every net server the process starts listening on and, when the
// process exits (or gets SIGUSR2), writes one marker line to stderr with how many listened at any time and how many still listen (before the exit tears them down).
// A test can then assert "every listener it started is closed" on the servers themselves, not by connecting to a port number that another test may own.
import net from 'node:net';

const started = new Set();
const original = net.Server.prototype.listen;
net.Server.prototype.listen = function listen(...args) {
  this.once('listening', () => { started.add(this); });
  return original.apply(this, args);
};
const report = () => {
  const listening = [...started].filter((server) => server.listening);
  const addresses = listening.map((server) => { const a = server.address(); return typeof a === 'string' || a === null ? String(a) : `${a.address}:${a.port}`; });
  process.stderr.write(`GRIMOIRE_TEST_LISTENERS ${JSON.stringify({ started: started.size, stillListening: listening.length, addresses })}\n`);
};
process.on('exit', report); // at exit, before the process tears its sockets down
process.on('SIGUSR2', report); // on demand, while the process lives (a test sends it and reads the newest report)
