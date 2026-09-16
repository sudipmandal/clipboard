import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');

async function startServer(extraEnv = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'clippy-backend-'));
  const dist = path.join(root, 'dist');
  mkdirSync(dist);
  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['src/backend/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: path.join(root, 'database.sqlite'),
      DIST_PATH: dist,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const baseURL = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseURL}/healthz`);
      if (response.ok) return { baseURL, child, root };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error(`Backend did not start: ${stderr}`);
}

async function stopServer(server) {
  server.child.kill('SIGTERM');
  await new Promise((resolve) => server.child.once('exit', resolve));
  rmSync(server.root, { recursive: true, force: true });
}

async function post(baseURL, text) {
  return fetch(`${baseURL}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

test('rejects oversized quoted and unquoted embedded images', async () => {
  const server = await startServer({ MAX_IMAGE_BYTES: '10' });
  try {
    const payload = 'data:image/png;base64,AAAAAAAAAAAAAAAAAAAA';
    assert.equal((await post(server.baseURL, `<img src="${payload}">`)).status, 413);
    assert.equal((await post(server.baseURL, `<img src=${payload}>`)).status, 413);
    assert.equal((await post(server.baseURL, '<img src="data&#58;image/png;base64,AAAAAAAAAAAAAAAAAAAA">')).status, 413);
    assert.equal((await post(server.baseURL, '<img src="data&colon;image/png;base64,AAAAAAAAAAAAAAAAAAAA">')).status, 413);
  } finally {
    await stopServer(server);
  }
});

test('serializes concurrent writes so the database capacity is not overrun', async () => {
  const server = await startServer({
    MAX_ENTRY_BYTES: '30000',
    MAX_DATABASE_BYTES: '110000',
  });
  try {
    const payload = `<p>${'x'.repeat(22000)}</p>`;
    const statuses = await Promise.all([
      post(server.baseURL, payload),
      post(server.baseURL, payload),
    ]).then((responses) => responses.map((response) => response.status).sort());
    assert.deepEqual(statuses, [201, 413]);
  } finally {
    await stopServer(server);
  }
});
