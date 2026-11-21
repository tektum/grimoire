import { createServer } from 'node:http';
import process from 'node:process';

const port = Number(process.env['GRIMOIRE_PORT']);
const server = createServer((_request, response) => { response.end('ok'); });
server.once('error', (error) => {
  console.log(JSON.stringify({ event: 'listen_failed', code: error instanceof Error && 'code' in error ? String(error.code) : 'unknown', port }));
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => { console.log(JSON.stringify({ event: 'http.listening', port })); });
