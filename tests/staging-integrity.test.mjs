import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'staging-integrity-'));
  const files = path.join(root, 'files');
  const child = spawn(process.execPath, ['-e', `
    const net = require('node:net'), listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function(port, cb) {
      this.once('listening', () => process.send(this.address().port));
      return listen.call(this, 0, '127.0.0.1', cb);
    };
    require('./src/backend/server');`], {
    cwd: path.resolve(import.meta.dirname, '..'), stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { TMPDIR: root, FILES_PATH: files, DATABASE_PATH: path.join(root, 'db.sqlite'),
      LEGACY_DATABASE_PATH: path.join(root, 'legacy'), DIST_PATH: path.join(root, 'dist'),
      MAX_FILES_BYTES: '64', MAX_FILE_BYTES: '64' },
  });
  const closed = once(child, 'close');
  t.after(async () => { child.kill(); await closed; await fs.rm(root, { recursive: true, force: true }); });
  const [port] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(5000) }),
    closed.then(() => { throw new Error('Server exited before listening'); })]);
  const base = `http://127.0.0.1:${port}`;
  return { base, files, put: (route, body) => fetch(`${base}/api/${route}/sample.bin`, { method: 'PUT', body }) };
}

test('same-length corruption is repaired for the original entry at full quota', async t => {
  const s = await fixture(t);
  const body = Buffer.alloc(64, 'a');
  const original = await s.put('upload', body);
  assert.equal(original.status, 201);
  const id = (await original.text()).trim().slice(1);
  const hash = createHash('sha256').update(body).digest('hex');
  await fs.writeFile(path.join(s.files, hash.slice(0, 2), hash), Buffer.alloc(64, 'b'));
  assert.equal((await s.put('files', body)).status, 201);
  const download = await fetch(`${s.base}/api/messages/${id}/files/1`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), body);
  assert.equal((await (await fetch(`${s.base}/api/config`)).json()).filesBytesUsed, 64);
  assert.deepEqual(await fs.readdir(path.join(s.files, '.tmp')), []);
});

function partial(s, t, route, length) {
  const req = http.request(`${s.base}/api/${route}/partial.bin`, {
    method: 'PUT', headers: length ? { 'content-length': length } : {},
  });
  t.after(() => req.destroy());
  let status;
  req.on('response', res => { status = res.statusCode; res.resume(); });
  req.on('error', error => { if (!req.destroyed) throw error; });
  return { req, status: () => status };
}

async function staged(s) {
  const dir = path.join(s.files, '.tmp');
  const files = await fs.readdir(dir);
  const sizes = await Promise.all(files.map(name => fs.stat(path.join(dir, name)).then(stat => stat.size,
    e => { if (e.code === 'ENOENT') return 0; throw e; })));
  return sizes.reduce((a, b) => a + b, 0);
}

async function until(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(10); }
  assert.fail('Expected upload state was not observed');
}

test('overlapping unfinished PUTs share one staging budget before either commits', async t => {
  const s = await fixture(t);
  const first = partial(s, t, 'files', 48);
  first.req.write(Buffer.alloc(40));
  await until(async () => await staged(s) === 40);
  const second = partial(s, t, 'upload');
  second.req.write(Buffer.alloc(32));
  await until(async () => second.status() || await staged(s) > 64);
  assert.ok(await staged(s) <= 64, 'unfinished bodies exceeded aggregate staging headroom');
  assert.equal(second.status(), 503);
  first.req.destroy();
  await until(async () => await staged(s) === 0);
  assert.equal((await s.put('upload', Buffer.alloc(64))).status, 201);
});

test('two duplicates can commit at full retained quota when their staging reservations fit', async t => {
  const s = await fixture(t);
  const large = Buffer.alloc(48, 'x'), small = Buffer.alloc(16, 'y');
  assert.equal((await s.put('files', large)).status, 201);
  assert.equal((await s.put('files', small)).status, 201);
  const first = partial(s, t, 'upload', large.length);
  first.req.write(large.subarray(0, 40));
  await until(async () => await staged(s) === 40);
  // The other route streams without a declared length. Only 16 bytes remain
  // reserved for it, but the first request's temporary bytes aren't retained.
  const second = partial(s, t, 'files');
  second.req.write(small); second.req.end();
  await until(second.status);
  assert.equal(second.status(), 201);
  assert.equal((await s.put('files', 'new')).status, 413);
  first.req.end(large.subarray(40));
  await until(first.status);
  assert.equal(first.status(), 201);
  assert.equal(await staged(s), 0);
  assert.equal((await (await fetch(`${s.base}/api/config`)).json()).filesBytesUsed, 64);
});
