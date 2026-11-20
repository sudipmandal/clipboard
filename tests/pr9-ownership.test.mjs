import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

// Use a kernel-assigned loopback port; startup purge completes before listen.
const bootstrap = `
  const net = require('node:net'), listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function(port, cb) {
    this.once('listening', () => process.send(this.address().port));
    return listen.call(this, 0, '127.0.0.1', cb);
  };
  require('./src/backend/server.js');`;

async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'pr9-ownership-'));
  const dbPath = path.join(root, 'database.sqlite');
  let child, closed, base;
  async function stop() {
    if (child) { child.kill(); await closed; child = null; }
  }
  t.after(async () => { await stop(); rmSync(root, { recursive: true, force: true }); });
  async function start() {
    child = spawn(process.execPath, ['-e', bootstrap], {
      cwd: path.resolve(import.meta.dirname, '..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { TMPDIR: root, DATABASE_PATH: dbPath, LEGACY_DATABASE_PATH: path.join(root, 'legacy.sqlite'),
        DIST_PATH: path.join(root, 'dist'), FILES_PATH: path.join(root, 'files') },
    });
    closed = once(child, 'close');
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const [port] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(10000) }),
      closed.then(() => { throw new Error(`Server exited before listening: ${stderr}`); })]);
    base = `http://127.0.0.1:${port}/`;
  }
  await start();
  const get = route => fetch(new URL(route, base));
  return { root, start, stop, get,
    sql(fn) { const db = new DatabaseSync(dbPath); try { return fn(db); } finally { db.close(); } },
    async upload(name, body, type = 'application/octet-stream') {
      const res = await fetch(`${base}api/files/${name}`, { method: 'PUT', headers: { 'Content-Type': type }, body });
      assert.equal(res.status, 201); return res.json();
    },
    post: (text, attachments = [], inlineUploads = []) => fetch(`${base}api/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, attachments, inlineUploads }) }),
  };
}

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('an unmatched inline claim rolls back the entry and leaves every claim retryable', async t => {
  const s = await fixture(t);
  const attachment = await s.upload('note.txt', 'draft');
  const image = await s.upload('first.png', png);
  const extra = await s.upload('second.png', png);
  const first = `<img src="${image.url}">`;
  const external = `<img src="https://example.invalid/${extra.url}">`;
  const rejected = await s.post(first + external, [attachment], [image, extra]);
  assert.equal(rejected.status, 409);
  assert.deepEqual(await s.get('api/messages').then(r => r.json()), []);
  const retry = await s.post(first + `<img src="${extra.url}">`, [attachment], [image, extra]);
  assert.equal(retry.status, 201);
  assert.deepEqual((await retry.json()).files.map(f => f.id), [attachment.id]);
});

test('a nonimage matching an img URL cannot satisfy an inline claim', async t => {
  const s = await fixture(t);
  const fake = await s.upload('fake.png', 'ordinary text', 'image/png');
  const text = `<img src="${fake.url}">`;
  assert.equal((await s.post(text, [], [fake])).status, 409);
  assert.deepEqual(await s.get('api/messages').then(r => r.json()), []);
  assert.equal((await s.post('download', [fake])).status, 201);
});

test('startup purge retires missing-parent rows but preserves same-hash owners', async t => {
  const s = await fixture(t);
  const unique = await s.upload('unique', 'orphan only');
  const shared = await s.upload('shared', 'same bytes');
  const pending = await s.upload('pending', 'same bytes');
  const linked = await s.upload('linked', 'same bytes');
  const source = await s.post('lost parent', [unique, shared]);
  assert.equal(source.status, 201);
  assert.equal((await s.post('live parent', [linked])).status, 201);
  const { id } = await source.json();
  await s.stop();
  const hash = s.sql(db => {
    db.exec('PRAGMA foreign_keys = OFF'); // Model a legacy database with dangling ownership.
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    return db.prepare('SELECT sha256 FROM attachments WHERE id = ?').get(unique.id).sha256;
  });
  const blob = path.join(s.root, 'files', hash.slice(0, 2), hash);
  assert.ok(existsSync(blob));
  await s.start();
  assert.deepEqual(s.sql(db => db.prepare('SELECT id FROM attachments ORDER BY id').all().map(r => r.id)), [pending.id, linked.id]);
  assert.equal(existsSync(blob), false);
  assert.equal((await s.get(linked.url)).status, 200);
  assert.equal((await s.get('api/config').then(r => r.json())).filesBytesUsed, Buffer.byteLength('same bytes'));
  assert.equal((await s.post('retry', [pending])).status, 201);
});
