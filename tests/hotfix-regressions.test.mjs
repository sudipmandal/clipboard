import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { findUrls } from '../src/linkify.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
async function startServer(extraEnv = {}, existingRoot = null) {
  const root = existingRoot || mkdtempSync(path.join(tmpdir(), 'clippy-hotfix-'));
  mkdirSync(path.join(root, 'dist'), { recursive: true });
  const port = 4900 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['src/backend/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: path.join(root, 'database.sqlite'),
      FILES_PATH: path.join(root, 'files'),
      LEGACY_DATABASE_PATH: path.join(root, 'no-legacy.sqlite'),
      DIST_PATH: path.join(root, 'dist'),
      MAX_FILE_BYTES: '104857600',
      MAX_FILES_BYTES: '5368709120',
      MAX_ENTRY_BYTES: '10485760',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const baseURL = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`${baseURL}/healthz`)).ok) return { root, child, baseURL }; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill(); await new Promise((resolve) => child.once('exit', resolve)); throw new Error(`server failed: ${stderr}`);
}
async function startFaultServer(faultScript, extraEnv = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'clippy-hotfix-fault-'));
  mkdirSync(path.join(root, 'dist'), { recursive: true });
  const port = 5400 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ['-e', `${faultScript};require('./src/backend/server.js')`], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(root, 'database.sqlite'), FILES_PATH: path.join(root, 'files'), LEGACY_DATABASE_PATH: path.join(root, 'no-legacy.sqlite'), DIST_PATH: path.join(root, 'dist'), MAX_FILE_BYTES: '104857600', MAX_FILES_BYTES: '5368709120', MAX_ENTRY_BYTES: '10485760', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseURL = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`${baseURL}/healthz`)).ok) return { root, child, baseURL }; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill(); await new Promise((resolve) => child.once('exit', resolve)); throw new Error('fault server failed');
}

async function stopServer(server) {
  if (server.child.exitCode === null) {
    server.child.kill('SIGTERM');
    await new Promise((resolve) => server.child.once('exit', resolve));
  }
  rmSync(server.root, { recursive: true, force: true });
}
async function upload(baseURL, name, body, type = 'image/png') {
  const response = await fetch(`${baseURL}/api/files/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'content-type': type }, body });
  return { response, file: await response.json() };
}
async function postEntry(baseURL, body) {
  return fetch(`${baseURL}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
function storedFiles(root) {
  const filesRoot = path.join(root, 'files');
  if (!existsSync(filesRoot)) return [];
  return readdirSync(filesRoot).filter((dir) => /^[0-9a-f]{2}$/.test(dir)).flatMap((dir) => readdirSync(path.join(filesRoot, dir)));
}
function rowCount(root, sql) {
  const db = new DatabaseSync(path.join(root, 'database.sqlite'));
  try { return db.prepare(sql).get().n; } finally { db.close(); }
}
const claims = (files) => files.map(({ id, token }) => ({ id, token }));

// B1
 test('MAX_FILES_PER_ENTRY counts inline and regular claims together', async () => {
  const server = await startServer({ MAX_FILES_PER_ENTRY: '2' });
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const files = [];
    for (let index = 0; index < 3; index += 1) files.push((await upload(server.baseURL, `i-${index}.png`, Buffer.concat([png, Buffer.from([index])]))).file);
    const response = await postEntry(server.baseURL, { text: files.map((f) => `<img src="${f.url}">`).join(''), inlineUploads: claims(files) });
    assert.equal(response.status, 400);
    assert.equal(rowCount(server.root, 'SELECT COUNT(*) AS n FROM messages'), 0);
  } finally { await stopServer(server); }
});

test('MAX_FILES_PER_ENTRY counts copied inline rows created during linking', async () => {
  const server = await startServer({ MAX_FILES_PER_ENTRY: '1' });
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const source = (await upload(server.baseURL, 'source.png', png)).file;
    const seeded = await (await postEntry(server.baseURL, { text: `<img src="${source.url}">`, inlineUploads: claims([source]) })).json();
    const regular = (await upload(server.baseURL, 'one.txt', Buffer.from('one'), 'text/plain')).file;
    const response = await postEntry(server.baseURL, { text: seeded.message, attachments: claims([regular]) });
    assert.equal(response.status, 400);
  } finally { await stopServer(server); }
});

// B2
 test('deleting pending uploads removes unreferenced blobs immediately', async () => {
  const server = await startServer({ MAX_FILES_BYTES: '100000' });
  try {
    for (let index = 0; index < 3; index += 1) {
      const { file } = await upload(server.baseURL, `cycle-${index}.bin`, Buffer.alloc(90000, index + 1), 'application/octet-stream');
      assert.equal((await fetch(`${server.baseURL}/api/files/${file.id}`, { method: 'DELETE', headers: { 'x-upload-token': file.token } })).status, 204);
      assert.deepEqual(storedFiles(server.root), []);
    }
  } finally { await stopServer(server); }
});

test('failed blob removal keeps a durable deletion intent', async () => {
  const server = await startServer();
  const root = server.root;
  try {
    const { file } = await upload(server.baseURL, 'retry.bin', Buffer.from('retry'), 'application/octet-stream');
    const [sha] = storedFiles(root);
    const blob = path.join(root, 'files', sha.slice(0, 2), sha);
    rmSync(blob); mkdirSync(blob);
    const accepted = await fetch(`${server.baseURL}/api/files/${file.id}`, { method: 'DELETE', headers: { 'x-upload-token': file.token } });
    assert.equal(accepted.status, 204);
    assert.equal(rowCount(root, 'SELECT COUNT(*) AS n FROM attachments WHERE message_id IS NULL'), 0);
    assert.equal(rowCount(root, 'SELECT COUNT(*) AS n FROM file_deletions'), 1);
  } finally { await stopServer(server); }
});

test('unlink I/O failure records durable intent and preserves quota until restart', async () => {
  const fault = "const fs=require('node:fs/promises'),rm=fs.rm.bind(fs);fs.rm=(p,...a)=>/[/\\\\][0-9a-f]{64}$/.test(String(p))?Promise.reject(Object.assign(new Error('injected unlink failure'),{code:'EIO'})):rm(p,...a)";
  const server = await startFaultServer(fault);
  const root = server.root;
  try {
    const body = Buffer.from('unlink me');
    const { file } = await upload(server.baseURL, 'unlink.bin', body, 'application/octet-stream');
    const accepted = await fetch(`${server.baseURL}/api/files/${file.id}`, { method: 'DELETE', headers: { 'x-upload-token': file.token } });
    assert.equal(accepted.status, 204);
    assert.equal((await (await fetch(`${server.baseURL}/api/config`)).json()).filesBytesUsed, body.length);
    assert.equal(rowCount(root, 'SELECT COUNT(*) AS n FROM attachments WHERE message_id IS NULL'), 0);
    assert.equal(rowCount(root, 'SELECT COUNT(*) AS n FROM file_deletions'), 1);
    server.child.kill('SIGTERM');
    await new Promise((resolve) => server.child.once('exit', resolve));
    const recovered = await startServer({}, root);
    try {
      assert.equal((await (await fetch(`${recovered.baseURL}/api/config`)).json()).filesBytesUsed, 0);
      assert.equal(rowCount(root, 'SELECT COUNT(*) AS n FROM file_deletions'), 0);
      assert.equal(storedFiles(root).length, 0);
    } finally { await stopServer(recovered); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing pending blob cannot be claimed into a saved entry', async () => {
  const server = await startServer();
  try {
    const { file } = await upload(server.baseURL, 'missing.bin', Buffer.from('missing'), 'application/octet-stream');
    const [sha] = storedFiles(server.root);
    rmSync(path.join(server.root, 'files', sha.slice(0, 2), sha));
    const response = await postEntry(server.baseURL, { text: 'must fail', attachments: claims([file]) });
    assert.equal(response.status, 409);
    assert.equal(rowCount(server.root, 'SELECT COUNT(*) AS n FROM messages'), 0);
  } finally { await stopServer(server); }
});

test('expiry unlink failure keeps physical bytes charged until recovery', async () => {
  const fault = "const fs=require('node:fs/promises'),rm=fs.rm.bind(fs);fs.rm=(p,...a)=>/[/\\\\][0-9a-f]{64}$/.test(String(p))?Promise.reject(Object.assign(new Error('injected expiry unlink failure'),{code:'EIO'})):rm(p,...a)";
  const server = await startFaultServer(fault, { MAX_FILES_BYTES: '64', RETENTION_TIME: '1s', PURGE_INTERVAL_MS: '100' });
  const root = server.root;
  try {
    const pending = (await upload(server.baseURL, 'linked.bin', Buffer.alloc(64, 2), 'application/octet-stream')).file;
    assert.equal((await postEntry(server.baseURL, { text: 'linked', attachments: claims([pending]) })).status, 201);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const entries = await (await fetch(`${server.baseURL}/api/messages`)).json();
      if (!entries.some((entry) => entry.message === 'linked') && rowCount(root, 'SELECT COUNT(*) AS n FROM file_deletions') === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal((await (await fetch(`${server.baseURL}/api/messages`)).json()).some((entry) => entry.message === 'linked'), false);
    assert.equal(rowCount(root, 'SELECT COUNT(*) AS n FROM file_deletions'), 1);
    assert.equal(storedFiles(root).length, 1);
    assert.equal((await (await fetch(`${server.baseURL}/api/config`)).json()).filesBytesUsed, 64);
    assert.equal((await upload(server.baseURL, 'replacement.bin', Buffer.alloc(64, 3), 'application/octet-stream')).response.status, 413);
    server.child.kill('SIGTERM');
    await new Promise((resolve) => server.child.once('exit', resolve));
    const recovered = await startServer({ MAX_FILES_BYTES: '64' }, root);
    try {
      assert.equal((await (await fetch(`${recovered.baseURL}/api/config`)).json()).filesBytesUsed, 0);
      assert.equal(rowCount(root, 'SELECT COUNT(*) AS n FROM file_deletions'), 0);
      assert.equal(storedFiles(root).length, 0);
    } finally { await stopServer(recovered); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('startup cancels stale deletion intent when a linked owner exists', async () => {
  const server = await startServer();
  const root = server.root;
  try {
    const body = Buffer.from('linked owner');
    const pending = (await upload(server.baseURL, 'owner.bin', body, 'application/octet-stream')).file;
    const saved = await (await postEntry(server.baseURL, { text: 'owner', attachments: claims([pending]) })).json();
    const [sha] = storedFiles(root);
    const db = new DatabaseSync(path.join(root, 'database.sqlite'));
    db.prepare('INSERT INTO file_deletions (sha256, size) VALUES (?, ?)').run(sha, body.length); db.close();
    server.child.kill('SIGTERM'); await new Promise((resolve) => server.child.once('exit', resolve));
    const restarted = await startServer({}, root);
    try {
      assert.equal(rowCount(root, 'SELECT COUNT(*) AS n FROM file_deletions'), 0);
      assert.equal((await fetch(`${restarted.baseURL}/${saved.files[0].url}`)).status, 200);
    } finally { await stopServer(restarted); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy hash-only intent preserves a valid pending owner', async () => {
  const server = await startServer();
  const root = server.root;
  try {
    const body = Buffer.from('pending survivor');
    const pending = (await upload(server.baseURL, 'pending.bin', body, 'application/octet-stream')).file;
    const [sha] = storedFiles(root);
    const db = new DatabaseSync(path.join(root, 'database.sqlite'));
    db.prepare('INSERT INTO file_deletions (sha256, size) VALUES (?, ?)').run(sha, body.length); db.close();
    server.child.kill('SIGTERM'); await new Promise((resolve) => server.child.once('exit', resolve));
    const restarted = await startServer({}, root);
    try {
      assert.equal(rowCount(root, 'SELECT COUNT(*) AS n FROM file_deletions'), 0);
      assert.equal((await postEntry(restarted.baseURL, { text: 'kept', attachments: claims([pending]) })).status, 201);
    } finally { await stopServer(restarted); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed completed-temp cleanup remains charged until restart', async () => {
  const fault = "const fsp=require('node:fs/promises'),rm=fsp.rm.bind(fsp);fsp.rm=(p,...a)=>String(p).includes('/.tmp/')?Promise.reject(Object.assign(new Error('tmp unlink failure'),{code:'EIO'})):rm(p,...a)";
  const server = await startFaultServer(fault, { MAX_FILES_BYTES: '64' });
  const root = server.root;
  try {
    const body = Buffer.alloc(64, 1);
    const original = (await upload(server.baseURL, 'original.bin', body, 'application/octet-stream')).file;
    assert.equal((await upload(server.baseURL, 'duplicate.bin', body, 'application/octet-stream')).response.status, 500);
    assert.equal((await fetch(`${server.baseURL}/api/files/${original.id}`, { method: 'DELETE', headers: { 'x-upload-token': original.token } })).status, 204);
    assert.equal((await (await fetch(`${server.baseURL}/api/config`)).json()).filesBytesUsed, 64);
    assert.equal((await upload(server.baseURL, 'other.bin', Buffer.alloc(64, 2), 'application/octet-stream')).response.status, 413);
    server.child.kill('SIGTERM'); await new Promise((resolve) => server.child.once('exit', resolve));
    const restarted = await startServer({ MAX_FILES_BYTES: '64' }, root);
    try { assert.equal((await (await fetch(`${restarted.baseURL}/api/config`)).json()).filesBytesUsed, 0); }
    finally { await stopServer(restarted); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('incomplete filesystem inventory fails quota admission closed', async () => {
  const fault = "const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),rd=fsp.readdir.bind(fsp);fsp.readdir=(p,...a)=>fs.existsSync(path.join(path.dirname(process.env.DATABASE_PATH),'scan-fault'))&&/[/\\\\][0-9a-f]{2}$/.test(String(p))?Promise.reject(Object.assign(new Error('injected scan failure'),{code:'EIO'})):rd(p,...a)";
  const server = await startFaultServer(fault, { MAX_FILES_BYTES: '64' });
  try {
    const body = Buffer.alloc(64, 1);
    const uploaded = (await upload(server.baseURL, 'orphan.bin', body, 'application/octet-stream')).file;
    const db = new DatabaseSync(path.join(server.root, 'database.sqlite'));
    db.prepare('DELETE FROM attachments WHERE id = ?').run(uploaded.id); db.close();
    const fs = await import('node:fs/promises');
    await fs.writeFile(path.join(server.root, 'scan-fault'), 'on');
    assert.equal((await (await fetch(`${server.baseURL}/api/config`)).json()).filesBytesUsed, null);
    assert.equal((await upload(server.baseURL, 'other.bin', Buffer.alloc(64, 2), 'application/octet-stream')).response.status, 500);
  } finally { await stopServer(server); }
});

test('expiry preserves a fresh pending duplicate of expired bytes', async () => {
  const server = await startServer({ RETENTION_TIME: '1s', PURGE_INTERVAL_MS: '100' });
  try {
    const body = Buffer.from('shared expiry bytes');
    const first = (await upload(server.baseURL, 'saved.bin', body, 'application/octet-stream')).file;
    assert.equal((await postEntry(server.baseURL, { text: 'expires', attachments: claims([first]) })).status, 201);
    const fresh = (await upload(server.baseURL, 'fresh.bin', body, 'application/octet-stream')).file;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!(await (await fetch(`${server.baseURL}/api/messages`)).json()).some((entry) => entry.message === 'expires')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal((await (await fetch(`${server.baseURL}/api/messages`)).json()).some((entry) => entry.message === 'expires'), false);
    assert.equal((await postEntry(server.baseURL, { text: 'survives', attachments: claims([fresh]) })).status, 201);
    assert.equal((await fetch(`${server.baseURL}/${fresh.url}`)).status, 200);
  } finally { await stopServer(server); }
});

test('re-upload repairs a missing charged blob without double-counting quota', async () => {
  const server = await startServer({ MAX_FILES_BYTES: '64' });
  try {
    const body = Buffer.alloc(64, 7);
    const original = (await upload(server.baseURL, 'original.bin', body, 'application/octet-stream')).file;
    const saved = await (await postEntry(server.baseURL, { text: 'repairable', attachments: claims([original]) })).json();
    const [sha] = storedFiles(server.root);
    rmSync(path.join(server.root, 'files', sha.slice(0, 2), sha));
    const repair = await upload(server.baseURL, 'repair.bin', body, 'application/octet-stream');
    assert.equal(repair.response.status, 201);
    assert.equal((await fetch(`${server.baseURL}/${saved.files[0].url}`)).status, 200);
    assert.equal((await (await fetch(`${server.baseURL}/api/config`)).json()).filesBytesUsed, 64);
  } finally { await stopServer(server); }
});

test('re-upload replaces oversized corruption and brings storage back under cap', async () => {
  const server = await startServer({ MAX_FILES_BYTES: '64' });
  try {
    const body = Buffer.alloc(64, 9);
    const original = (await upload(server.baseURL, 'corrupt.bin', body, 'application/octet-stream')).file;
    const saved = await (await postEntry(server.baseURL, { text: 'corrupt repair', attachments: claims([original]) })).json();
    const [sha] = storedFiles(server.root);
    const fs = await import('node:fs/promises');
    await fs.writeFile(path.join(server.root, 'files', sha.slice(0, 2), sha), Buffer.alloc(66, 9));
    assert.equal((await upload(server.baseURL, 'correct.bin', body, 'application/octet-stream')).response.status, 201);
    assert.equal((await fetch(`${server.baseURL}/${saved.files[0].url}`)).status, 200);
    assert.equal((await (await fetch(`${server.baseURL}/api/config`)).json()).filesBytesUsed, 64);
  } finally { await stopServer(server); }
});

test('copying a saved inline image rejects a missing backing blob', async () => {
  const server = await startServer();
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const source = (await upload(server.baseURL, 'copy.png', png)).file;
    const saved = await (await postEntry(server.baseURL, { text: `<img src="${source.url}">`, inlineUploads: claims([source]) })).json();
    const [sha] = storedFiles(server.root);
    rmSync(path.join(server.root, 'files', sha.slice(0, 2), sha));
    const response = await postEntry(server.baseURL, { text: saved.message });
    assert.equal(response.status, 409);
    assert.equal(rowCount(server.root, 'SELECT COUNT(*) AS n FROM messages'), 1);
  } finally { await stopServer(server); }
});

test('non-regular or wrong-size pending blob cannot be claimed', async () => {
  const server = await startServer();
  try {
    const body = Buffer.from('regular bytes');
    const { file } = await upload(server.baseURL, 'shape.bin', body, 'application/octet-stream');
    const [sha] = storedFiles(server.root);
    const blob = path.join(server.root, 'files', sha.slice(0, 2), sha);
    rmSync(blob); mkdirSync(blob);
    assert.equal((await postEntry(server.baseURL, { text: 'directory', attachments: claims([file]) })).status, 409);
    rmSync(blob, { recursive: true });
    const fs = await import('node:fs/promises');
    await fs.writeFile(blob, Buffer.from('x'));
    assert.equal((await postEntry(server.baseURL, { text: 'wrong size', attachments: claims([file]) })).status, 409);
  } finally { await stopServer(server); }
});

test('startup reconciles interrupted deletion intent without phantom quota', async () => {
  const server = await startServer({ MAX_FILES_BYTES: '64' });
  const root = server.root;
  try {
    const body = Buffer.alloc(48, 1);
    const { file } = await upload(server.baseURL, 'interrupted.bin', body, 'application/octet-stream');
    const [sha] = storedFiles(root);
    const db = new DatabaseSync(path.join(root, 'database.sqlite'));
    db.prepare('INSERT INTO file_deletions (sha256, size) VALUES (?, ?)').run(sha, body.length);
    db.close();
    rmSync(path.join(root, 'files', sha.slice(0, 2), sha));
    server.child.kill('SIGTERM');
    await new Promise((resolve) => server.child.once('exit', resolve));
    const restarted = await startServer({ MAX_FILES_BYTES: '64' }, root);
    try {
      assert.equal(rowCount(root, `SELECT COUNT(*) AS n FROM attachments WHERE id = ${file.id}`), 0);
      assert.equal((await (await fetch(`${restarted.baseURL}/api/config`)).json()).filesBytesUsed, 0);
      assert.equal((await upload(restarted.baseURL, 'replacement.bin', Buffer.alloc(64, 2), 'application/octet-stream')).response.status, 201);
    } finally { await stopServer(restarted); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('over-limit rollback cannot expose uncommitted entry or undo acknowledged mutation', async () => {
  const server = await startServer({ MAX_FILES_PER_ENTRY: '20' });
  try {
    const marker = await (await postEntry(server.baseURL, { text: 'independent entry' })).json();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const copiedHtml = [];
    for (let group = 0; group < 2; group += 1) {
      const files = [];
      for (let index = 0; index < 16; index += 1) files.push((await upload(server.baseURL, `copy-${group}-${index}.png`, Buffer.concat([png, Buffer.from([group, index])]))).file);
      const source = await (await postEntry(server.baseURL, { text: files.map((file) => `<img src="${file.url}">`).join(''), inlineUploads: claims(files) })).json();
      copiedHtml.push(source.message);
    }
    const rejected = postEntry(server.baseURL, { text: `proposed${copiedHtml.join('')}` });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const listed = fetch(`${server.baseURL}/api/messages`).then((response) => response.json());
    const patched = fetch(`${server.baseURL}/api/messages/${marker.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ is_pinned: true }),
    });
    assert.equal((await rejected).status, 400);
    assert.equal((await patched).status, 200);
    assert.equal((await listed).some((entry) => entry.message.startsWith('proposed')), false);
    const final = await (await fetch(`${server.baseURL}/api/messages`)).json();
    assert.equal(final.find((entry) => entry.id === marker.id).is_pinned, true);
  } finally { await stopServer(server); }
});

// B5 server half: token-authenticated delete must reclaim physical quota.
test('failed-save inline claim can be discarded without quota residue', async () => {
  const server = await startServer({ MAX_ENTRY_BYTES: '1000' });
  try {
    const { file } = await upload(server.baseURL, 'failed.png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    assert.equal((await postEntry(server.baseURL, { text: 'x'.repeat(2000), inlineUploads: claims([file]) })).status, 413);
    assert.equal((await fetch(`${server.baseURL}/api/files/${file.id}`, { method: 'DELETE', headers: { 'x-upload-token': file.token } })).status, 204);
    assert.deepEqual(storedFiles(server.root), []);
  } finally { await stopServer(server); }
});

// B6
test('adjacent URLs split without truncating valid pipe or backslash data', () => {
  assert.deepEqual(findUrls('https://first.example/a|https://second.example/b').map((item) => item.url), ['https://first.example/a', 'https://second.example/b']);
  assert.deepEqual(findUrls('https://example.org/search?filters=red|green').map((item) => item.url), ['https://example.org/search?filters=red|green']);
  assert.deepEqual(findUrls(String.raw`https://example.org/search?path=C:\logs`).map((item) => item.url), [String.raw`https://example.org/search?path=C:\logs`]);
  assert.deepEqual(findUrls(String.raw`https://a.example/x\https://b.example/y`).map((item) => item.url), ['https://a.example/x', 'https://b.example/y']);
});
