import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

// Bind the real server to a kernel-assigned loopback port; report it only after startup recovery.
const bootstrap = `
  const net = require('node:net'), listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function(port, cb) {
    this.once('listening', () => process.send(this.address().port));
    return listen.call(this, 0, '127.0.0.1', cb);
  };
  const fs = require('node:fs/promises');
  for (const method of (process.env.FAULTS || '').split(',').filter(Boolean)) {
    const original = fs[method];
    fs[method] = async (p, ...args) => {
      if (p === process.env.FAULT_PATH) throw Object.assign(new Error('injected '+method), {code:'EIO'});
      return original(p, ...args);
    };
  }
  require('./src/backend/server.js');`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cycle6-storage-'));
  const dbPath = path.join(root, 'db.sqlite');
  const files = path.join(root, 'files');
  let child, closed, base;
  async function stop() {
    if (child) { child.kill('SIGKILL'); await closed; child = null; }
  }
  t.after(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    files, stop,
    async start(faults = '', target = '') {
      child = spawn(process.execPath, ['-e', bootstrap], {
        cwd: path.resolve(import.meta.dirname, '..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { DATABASE_PATH: dbPath, FILES_PATH: files, LEGACY_DATABASE_PATH: path.join(root, 'legacy'),
          DIST_PATH: path.join(root, 'dist'), TMPDIR: root, MAX_FILES_BYTES: '64', FAULTS: faults, FAULT_PATH: target },
      });
      closed = once(child, 'close');
      let log = ''; child.stderr.on('data', chunk => { log += chunk; });
      const [port] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(10000) }),
        closed.then(() => { throw new Error(`Server exited before listening: ${log}`); })]);
      base = `http://127.0.0.1:${port}`;
    },
    sql(fn) { const db = new DatabaseSync(dbPath); try { return fn(db); } finally { db.close(); } },
    get: (route) => fetch(new URL(route, base)),
    upload: (body) => fetch(`${base}/api/files/test.bin`, { method: 'PUT', body }),
    claim: ({ id, token }) => fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'saved', attachments: [{ id, token }] }) }),
  };
}

const body = Buffer.from('shared data');
const hash = createHash('sha256').update(body).digest('hex');
const blobPath = (s) => path.join(s.files, hash.slice(0, 2), hash);
async function pending(s) {
  const response = await s.upload(body); assert.equal(response.status, 201); return response.json();
}
function intent(s) {
  s.sql(db => db.prepare('INSERT INTO file_deletions (sha256, size) VALUES (?, ?)').run(hash, body.length));
}
const intents = (s) => s.sql(db => db.prepare('SELECT count(*) AS n FROM file_deletions').get().n);
const owners = (s) => s.sql(db => db.prepare('SELECT id FROM attachments ORDER BY id').all().map(row => row.id));

for (const method of ['stat', 'open']) {
  test(`legacy recovery defers on blob ${method} EIO without consuming the pending claim`, async t => {
    const s = fixture(t); await s.start();
    const file = await pending(s); await s.stop(); intent(s);
    await s.start(method, blobPath(s));
    assert.deepEqual(owners(s), [file.id]); assert.equal(intents(s), 1);
    assert.deepEqual(fs.readFileSync(blobPath(s)), body);
    await s.stop(); await s.start();
    assert.equal(intents(s), 0); assert.equal((await s.claim(file)).status, 201);
  });
}

test('legacy recovery retires only the wrong-size pending sibling', async t => {
  const s = fixture(t); await s.start();
  const valid = await pending(s), invalid = await pending(s); await s.stop();
  s.sql(db => db.prepare('UPDATE attachments SET size = size + 1 WHERE id = ?').run(invalid.id)); intent(s);
  await s.start(); assert.deepEqual(owners(s), [valid.id]); assert.equal(intents(s), 0);
  assert.deepEqual(fs.readFileSync(blobPath(s)), body);
  assert.equal((await s.claim(valid)).status, 201); assert.equal((await s.claim(invalid)).status, 409);
});

test('a stranded temp does not block reads or hide usage when unlink or inventory fails', async t => {
  const s = fixture(t); await s.start();
  const file = await pending(s); assert.equal((await s.claim(file)).status, 201); await s.stop();
  const stranded = path.join(s.files, '.tmp', 'a-stranded');
  const other = path.join(s.files, '.tmp', 'z-removable');
  fs.writeFileSync(stranded, Buffer.alloc(64 - body.length)); fs.writeFileSync(other, 'remove me');
  await s.start('rm', stranded);
  assert.deepEqual(Buffer.from(await (await s.get(file.url)).arrayBuffer()), body);
  assert.equal(fs.existsSync(other), false); assert.ok(fs.existsSync(stranded));
  assert.equal((await (await s.get('/api/config')).json()).filesBytesUsed, 64);
  assert.equal((await s.upload('extra')).status, 413); await s.stop();
  await s.start('stat', stranded);
  assert.deepEqual(Buffer.from(await (await s.get(file.url)).arrayBuffer()), body);
  assert.equal((await (await s.get('/api/config')).json()).filesBytesUsed, null);
  assert.equal((await s.upload('extra')).ok, false); assert.deepEqual(owners(s), [file.id]); await s.stop();
  await s.start(); assert.equal(fs.existsSync(stranded), false); assert.equal((await s.upload('extra')).status, 201);
});

test('an unexpected staging directory is unknown usage, not zero bytes', async t => {
  const s = fixture(t); await s.start();
  const file = await pending(s); assert.equal((await s.claim(file)).status, 201); await s.stop();
  const directory = path.join(s.files, '.tmp', 'unexpected');
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'stranded'), Buffer.alloc(64));
  await s.start();
  assert.deepEqual(Buffer.from(await (await s.get(file.url)).arrayBuffer()), body);
  assert.equal((await (await s.get('/api/config')).json()).filesBytesUsed, null);
  assert.equal((await s.upload('extra')).ok, false); assert.deepEqual(owners(s), [file.id]);
});
