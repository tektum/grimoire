import { run } from './lifecycle/run.js';

// Entry point: node apps/server/dist/main.js. Exit codes are in lifecycle/process.ts.
await run();
