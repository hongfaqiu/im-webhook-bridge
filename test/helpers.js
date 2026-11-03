import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const tmpdir = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
export async function serve(handler) {
  const srv = http.createServer(handler);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { srv, base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}
export const readBody = req => new Promise(r => { const c = []; req.on('data', x => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });
export async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(20); }
  throw new Error('等待超时');
}
