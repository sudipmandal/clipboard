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
    env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(root, 'database.sqlite'), DIST_PATH: path.join(root, 'dist'), ...extraEnv },
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
async function stopServer(server) {
  server.child.kill('SIGTERM');
  await new Promise((resolve) => server.child.once('exit', resolve));
  rmSync(server.root, { recursive: true, force: true });
}
async function upload(baseURL, name, body, type = 'image/png') {
  const response = await fetch(`${baseURL}/api/files/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'content-type': type }, body });
  return { response, file: await response.json() };
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
    const response = await fetch(`${server.baseURL}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: files.map((f) => `<img src="${f.url}">`).join(''), inlineUploads: claims(files) }) });
    assert.equal(response.status, 400);
    assert.equal(rowCount(server.root, 'SELECT COUNT(*) AS n FROM messages'), 0);
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

// B5
// The UI calls this token-authenticated deletion on entry failure; server must reclaim the blob immediately.
test('failed-save inline claim can be discarded without quota residue', async () => {
  const server = await startServer({ MAX_ENTRY_BYTES: '1000' });
  try {
    const { file } = await upload(server.baseURL, 'failed.png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    const failed = await fetch(`${server.baseURL}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(2000), inlineUploads: claims([file]) }) });
    assert.equal(failed.status, 413);
    assert.equal((await fetch(`${server.baseURL}/api/files/${file.id}`, { method: 'DELETE', headers: { 'x-upload-token': file.token } })).status, 204);
    assert.deepEqual(storedFiles(server.root), []);
  } finally { await stopServer(server); }
});

// B6
test('adjacent URLs separated by prose delimiters are distinct', () => {
  assert.deepEqual(findUrls('https://first.example/a|https://second.example/b').map((item) => item.url), ['https://first.example/a', 'https://second.example/b']);
});
