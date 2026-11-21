import { existsSync, writeFileSync } from 'node:fs';
import process from 'node:process';

// Fails like the product on the first start (a collision), then listens normally.
const marker = process.env['COLLIDE_MARKER'] ?? '';
const port = Number(process.env['GRIMOIRE_PORT']);
if (!existsSync(marker)) {
  writeFileSync(marker, 'x');
  console.log(JSON.stringify({ event: 'server.start_failed', errorCode: 'EADDRINUSE', port }));
  process.exit(1);
}
console.log(JSON.stringify({ event: 'http.listening', port }));
setInterval(() => undefined, 1000);
