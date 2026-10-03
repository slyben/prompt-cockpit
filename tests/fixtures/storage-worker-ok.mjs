import { parentPort } from 'node:worker_threads';
parentPort.postMessage({ value: 'x'.repeat(5_000_000) });
