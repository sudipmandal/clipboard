import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { findUrls } from '../src/linkify.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
async function startServer(extraEnv = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'clippy-hotfix-'));
  mkdirSync(path.join(root, 'dist'));
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
  child.kill(); throw new Error(`server failed: ${stderr}`);
}
async function startFaultServer(faultScript, extraEnv = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'clippy-hotfix-fault-'));
  mkdirSync(path.join(root, 'dist'));
  const port = 5400 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ['-e', `${faultScript};require('./src/backend/server.js')`], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(root, 'database.sqlite'), FILES_PATH: path.join(root, 'files'), LEGACY_DATABASE_PATH: path.join(root, 'no-legacy.sqlite'), DIST_PATH: path.join(root, 'dist'), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseURL = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`${baseURL}/healthz`)).ok) return { root, child, baseURL }; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill(); throw new Error('fault server failed');
}

async function stopServer(server) {
  server.child.kill('SIGTERM');
  await new Promise((resolve) => server.child.once('exit', resolve));
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

test('failed blob removal keeps pending metadata and token retryable', async () => {
  const server = await startServer();
  try {
    const { file } = await upload(server.baseURL, 'retry.bin', Buffer.from('retry'), 'application/octet-stream');
    const [sha] = storedFiles(server.root);
    const blob = path.join(server.root, 'files', sha.slice(0, 2), sha);
    rmSync(blob);
    mkdirSync(blob);
    const failed = await fetch(`${server.baseURL}/api/files/${file.id}`, { method: 'DELETE', headers: { 'x-upload-token': file.token } });
    assert.equal(failed.status, 500);
    assert.equal(rowCount(server.root, 'SELECT COUNT(*) AS n FROM attachments WHERE message_id IS NULL'), 1);
    rmSync(blob, { recursive: true });
    assert.equal((await fetch(`${server.baseURL}/api/files/${file.id}`, { method: 'DELETE', headers: { 'x-upload-token': file.token } })).status, 204);
  } finally { await stopServer(server); }
});

test('unlink I/O failure preserves quota and token for retry', async () => {
  const fault = "const fs=require('node:fs/promises'),rm=fs.rm.bind(fs);fs.rm=(p,...a)=>/[/\\\\][0-9a-f]{64}$/.test(String(p))?Promise.reject(Object.assign(new Error('injected unlink failure'),{code:'EIO'})):rm(p,...a)";
  const server = await startFaultServer(fault);
  try {
    const body = Buffer.from('unlink me');
    const { file } = await upload(server.baseURL, 'unlink.bin', body, 'application/octet-stream');
    const failed = await fetch(`${server.baseURL}/api/files/${file.id}`, { method: 'DELETE', headers: { 'x-upload-token': file.token } });
    assert.equal(failed.status, 500);
    const config = await (await fetch(`${server.baseURL}/api/config`)).json();
    assert.equal(config.filesBytesUsed, body.length);
    assert.equal(rowCount(server.root, 'SELECT COUNT(*) AS n FROM attachments WHERE message_id IS NULL'), 1);
  } finally { await stopServer(server); }
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
