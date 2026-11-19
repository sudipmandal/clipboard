import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const textHelpers = requireCjs('../src/backend/text.js');

const projectRoot = path.resolve(import.meta.dirname, '..');

async function startServer(extraEnv = {}, existingRoot = null) {
  const root = existingRoot || mkdtempSync(path.join(tmpdir(), 'clippy-backend-'));
  const dist = path.join(root, 'dist');
  mkdirSync(dist, { recursive: true });
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
    MAX_DATABASE_BYTES: '122000', // empty DB is 24 KB with the attachments table + indexes
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

test('RETENTION_TIME accepts units, bare days and 0', () => {
  const { parseDuration, formatDuration } = textHelpers;
  assert.equal(parseDuration('10d'), 864000);
  assert.equal(parseDuration('36h'), 129600);
  assert.equal(parseDuration('90m'), 5400);
  assert.equal(parseDuration('2w'), 1209600);
  assert.equal(parseDuration('10'), 864000);
  assert.equal(parseDuration('0'), 0);
  assert.equal(parseDuration('ten days'), null);
  assert.equal(formatDuration(864000), '10d');
  assert.equal(formatDuration(0), 'off');
});

test('HTML from the rich editor converts to plain text with line breaks', () => {
  const { htmlToPlainText } = textHelpers;
  assert.equal(htmlToPlainText('first<div>second</div><div><br></div><div>x&nbsp;&amp;&lt;y&gt;</div>'), 'first\nsecond\n\nx &<y>');
  assert.equal(htmlToPlainText('<b>bold</b> <img src="data:x">'), 'bold [image]');
});

test('plain-text push and .txt pull round-trip CLI output as monospace', async () => {
  const server = await startServer();
  try {
    const body = 'A:admin@pe1# show router interface\n  system      10.0.0.1/32   Up\n  to-pe2 <&> 192.0.2.1/31  Up\n';
    const pushed = await fetch(`${server.baseURL}/api/text`, { method: 'PUT', body });
    assert.equal(pushed.status, 201);
    const id = (await pushed.text()).trim();
    assert.match(id, /^#\d+$/);
    assert.equal(await (await fetch(`${server.baseURL}/api/latest.txt`)).text(), body);
    assert.equal(await (await fetch(`${server.baseURL}/api/messages/${id.slice(1)}.txt`)).text(), body);
    const [entry] = await (await fetch(`${server.baseURL}/api/messages`)).json();
    assert.equal(entry.mono, true);
    assert.equal((await fetch(`${server.baseURL}/api/messages/999.txt`)).status, 404);
  } finally {
    await stopServer(server);
  }
});

test('plain-text POST is rejected to prevent cross-origin simple-request injection', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseURL}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://attacker.example' },
      body: 'attacker-controlled clipboard entry',
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await (await fetch(`${server.baseURL}/api/messages`)).json(), []);
  } finally {
    await stopServer(server);
  }
});

test('cross-origin simple POST cannot restore a deleted entry', async () => {
  const server = await startServer();
  try {
    const created = await (await post(server.baseURL, '<p>keep deleted</p>')).json();
    assert.equal((await fetch(`${server.baseURL}/api/messages/${created.id}`, { method: 'DELETE' })).status, 204);
    const response = await fetch(`${server.baseURL}/api/messages/${created.id}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://attacker.example' },
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await (await fetch(`${server.baseURL}/api/messages`)).json(), []);
  } finally {
    await stopServer(server);
  }
});

test('delete is soft and can be restored; mono can be toggled', async () => {
  const server = await startServer();
  try {
    const created = await (await post(server.baseURL, '<p>keep me</p>')).json();
    assert.equal(created.mono, false);
    const patched = await fetch(`${server.baseURL}/api/messages/${created.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mono: true }),
    });
    assert.equal((await patched.json()).mono, true);
    assert.equal((await fetch(`${server.baseURL}/api/messages/${created.id}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(await (await fetch(`${server.baseURL}/api/messages`)).json(), []);
    assert.equal((await fetch(`${server.baseURL}/api/latest.txt`)).status, 404);
    const restored = await fetch(`${server.baseURL}/api/messages/${created.id}/restore`, { method: 'PUT' });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).id, created.id);
    assert.equal((await (await fetch(`${server.baseURL}/api/messages`)).json()).length, 1);
    assert.equal((await fetch(`${server.baseURL}/api/messages/${created.id}/restore`, { method: 'PUT' })).status, 404);
  } finally {
    await stopServer(server);
  }
});

test('restore is rejected after the server-side undo window expires', async () => {
  const server = await startServer({ RESTORE_WINDOW_SECONDS: '1' });
  try {
    const created = await (await post(server.baseURL, '<p>expire undo</p>')).json();
    assert.equal((await fetch(`${server.baseURL}/api/messages/${created.id}`, { method: 'DELETE' })).status, 204);
    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.equal((await fetch(`${server.baseURL}/api/messages/${created.id}/restore`, { method: 'PUT' })).status, 404);
    assert.deepEqual(await (await fetch(`${server.baseURL}/api/messages`)).json(), []);
  } finally {
    await stopServer(server);
  }
});

test('pinned entries bypass retention until they are unpinned', async () => {
  const server = await startServer({ RETENTION_TIME: '1s', PURGE_INTERVAL_MS: '300' });
  try {
    const pinned = await (await post(server.baseURL, '<p>keep pinned</p>')).json();
    const expiring = await (await post(server.baseURL, '<p>expire normally</p>')).json();
    const patched = await fetch(`${server.baseURL}/api/messages/${pinned.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_pinned: true }),
    });
    assert.equal(patched.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    let entries = await (await fetch(`${server.baseURL}/api/messages`)).json();
    assert.deepEqual(entries.map((entry) => entry.id), [pinned.id]);
    assert.equal(entries[0].is_pinned, true);
    assert.equal(entries.some((entry) => entry.id === expiring.id), false);

    assert.equal((await fetch(`${server.baseURL}/api/messages/${pinned.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_pinned: false }),
    })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 700));
    entries = await (await fetch(`${server.baseURL}/api/messages`)).json();
    assert.deepEqual(entries, []);
  } finally {
    await stopServer(server);
  }
});

test('entries older than RETENTION_TIME are purged', async () => {
  const server = await startServer({ RETENTION_TIME: '1s', PURGE_INTERVAL_MS: '300' });
  try {
    assert.equal((await (await fetch(`${server.baseURL}/api/config`)).json()).retention, '1s');
    assert.equal((await post(server.baseURL, '<p>short-lived</p>')).status, 201);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    assert.deepEqual(await (await fetch(`${server.baseURL}/api/messages`)).json(), []);
  } finally {
    await stopServer(server);
  }
});

async function upload(baseURL, name, body, { type, route = 'files', headers = {} } = {}) {
  return fetch(`${baseURL}/api/${route}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { ...(type ? { 'Content-Type': type } : {}), ...headers },
    body,
  });
}

// attachments / inlineUploads: uploads as returned by PUT /api/files ({ id, token, … })
async function postEntry(baseURL, text, attachments = [], inlineUploads = []) {
  const claim = (file) => ({ id: file.id, token: file.token });
  return fetch(`${baseURL}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, attachments: attachments.map(claim), inlineUploads: inlineUploads.map(claim) }),
  });
}

function countRows(root, sql) {
  const db = new DatabaseSync(path.join(root, 'database.sqlite'));
  try { return db.prepare(sql).get().n; } finally { db.close(); }
}

function tmpFiles(root) {
  const tmp = path.join(root, 'files', '.tmp');
  return existsSync(tmp) ? readdirSync(tmp) : [];
}

// Content files on disk under <root>/files/xx/<sha256> (ignores the .tmp upload directory).
function storedFiles(root) {
  const filesRoot = path.join(root, 'files');
  if (!existsSync(filesRoot)) return [];
  return readdirSync(filesRoot).filter((dir) => /^[0-9a-f]{2}$/.test(dir)).flatMap((dir) => readdirSync(path.join(filesRoot, dir)));
}

test('files are stored on disk outside SQLite, linked to an entry and downloadable', async () => {
  const server = await startServer();
  try {
    const content = Buffer.from('A:admin@pe1# admin show configuration\n'.repeat(20000));
    const uploaded = await upload(server.baseURL, 'pe1 config.cfg', content, { type: 'text/plain' });
    assert.equal(uploaded.status, 201);
    const file = await uploaded.json();
    assert.equal(file.size, content.length);
    const sha = createHash('sha256').update(content).digest('hex');
    assert.ok(existsSync(path.join(server.root, 'files', sha.slice(0, 2), sha)));
    assert.ok(statSync(path.join(server.root, 'database.sqlite')).size < content.length / 4);

    const created = await postEntry(server.baseURL, '', [file]);
    assert.equal(created.status, 201);
    const entry = await created.json();
    assert.equal(entry.files.length, 1);
    assert.equal(entry.files[0].name, 'pe1 config.cfg');
    const listed = await (await fetch(`${server.baseURL}/api/messages`)).json();
    assert.equal(listed[0].files[0].id, file.id);

    const download = await fetch(`${server.baseURL}/${entry.files[0].url}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.match(download.headers.get('content-disposition'), /^attachment; filename="pe1 config\.cfg"/);
    assert.ok(Buffer.from(await download.arrayBuffer()).equals(content));
    const byIndex = await fetch(`${server.baseURL}/api/messages/${entry.id}/files/1`);
    assert.ok(Buffer.from(await byIndex.arrayBuffer()).equals(content));
    assert.equal((await fetch(`${server.baseURL}/api/messages/${entry.id}/files/2`)).status, 404);

    assert.equal((await postEntry(server.baseURL, '<p>reuse</p>', [file])).status, 409);
    const config = await (await fetch(`${server.baseURL}/api/config`)).json();
    assert.equal(config.filesBytesUsed, content.length);
    assert.equal(config.maxFileBytes, 100 * 1024 * 1024);
    assert.equal(config.maxFilesBytes, 5 * 1024 * 1024 * 1024);
  } finally {
    await stopServer(server);
  }
});

test('files over MAX_FILE_BYTES or past MAX_FILES_BYTES are rejected and identical files are stored once', async () => {
  const server = await startServer({ MAX_FILE_BYTES: '1000', MAX_FILES_BYTES: '1500' });
  try {
    const tooLarge = await upload(server.baseURL, 'big.bin', Buffer.alloc(2000, 1));
    assert.equal(tooLarge.status, 413);
    assert.match((await tooLarge.json()).error, /larger than the 1000 B limit/);
    assert.deepEqual(storedFiles(server.root), []);

    const first = Buffer.alloc(900, 2);
    assert.equal((await upload(server.baseURL, 'a.bin', first)).status, 201);
    const full = await upload(server.baseURL, 'b.bin', Buffer.alloc(900, 3));
    assert.equal(full.status, 413);
    assert.match((await full.json()).error, /storage is full/);
    assert.equal((await upload(server.baseURL, 'a-copy.bin', first)).status, 201);
    assert.equal(storedFiles(server.root).length, 1);
    assert.equal((await (await fetch(`${server.baseURL}/api/config`)).json()).filesBytesUsed, 900);
  } finally {
    await stopServer(server);
  }
});

test('terminal upload creates an entry and the .txt view links its files', async () => {
  const server = await startServer();
  try {
    const uploaded = await upload(server.baseURL, 'capture.pcap', Buffer.from('pcap-bytes'), { route: 'upload' });
    assert.equal(uploaded.status, 201);
    const id = (await uploaded.text()).trim();
    assert.match(id, /^#\d+$/);
    const text = await (await fetch(`${server.baseURL}/api/messages/${id.slice(1)}.txt`, {
      headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'lab.example', 'X-Forwarded-Prefix': '/clipboard' },
    })).text();
    assert.match(text, /^\[file\] capture\.pcap \(10 B\) https:\/\/lab\.example\/clipboard\/api\/files\/\d+\/capture\.pcap\n$/);
    const [entry] = await (await fetch(`${server.baseURL}/api/messages`)).json();
    assert.equal(entry.files[0].type, 'application/vnd.tcpdump.pcap');
  } finally {
    await stopServer(server);
  }
});

test('pasted images are stored as files and shown inline; unsafe types are never served inline', async () => {
  const server = await startServer();
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const image = await (await upload(server.baseURL, 'pasted-image.png', png, { type: 'image/png' })).json();
    const entry = await (await postEntry(server.baseURL, `<p>see</p><img src="${image.url}">`, [], [image])).json();
    assert.deepEqual(entry.files, []);
    assert.match(entry.message, new RegExp(`src="api/files/${image.id}/pasted-image\\.png"`));
    const shown = await fetch(`${server.baseURL}/${image.url}`);
    assert.equal(shown.headers.get('content-type'), 'image/png');
    assert.match(shown.headers.get('content-disposition'), /^inline;/);
    assert.match((await fetch(`${server.baseURL}/${image.url}?download`)).headers.get('content-disposition'), /^attachment;/);

    // the same image pasted into a second entry gets its own reference, so deleting one entry keeps the other intact
    const copy = await (await postEntry(server.baseURL, `<img src="https://lab.example/clipboard/${entry.message.match(/api\/files\/\d+\/[^"]+/)[0]}">`)).json();
    const copyUrl = copy.message.match(/api\/files\/(\d+)\//);
    assert.ok(copyUrl && Number(copyUrl[1]) !== image.id);
    assert.equal(storedFiles(server.root).length, 1);

    const page = await (await upload(server.baseURL, 'evil.html', Buffer.from('<script>alert(1)</script>'), { type: 'text/html' })).json();
    assert.equal((await postEntry(server.baseURL, '', [page])).status, 201);
    const served = await fetch(`${server.baseURL}/${page.url}`);
    assert.equal(served.headers.get('content-type'), 'application/octet-stream');
    assert.match(served.headers.get('content-disposition'), /^attachment;/);
    assert.match(served.headers.get('content-security-policy'), /sandbox/);
  } finally {
    await stopServer(server);
  }
});

test('unsent uploads can be removed and files of purged entries are deleted from disk', async () => {
  const server = await startServer({ RETENTION_TIME: '1s', PURGE_INTERVAL_MS: '300' });
  try {
    const pending = await (await upload(server.baseURL, 'draft.txt', Buffer.from('draft'))).json();
    const remove = (token) => fetch(`${server.baseURL}/api/files/${pending.id}`, { method: 'DELETE', headers: token ? { 'X-Upload-Token': token } : {} });
    assert.equal((await remove()).status, 404);
    assert.equal((await remove('not-the-token')).status, 404);
    assert.equal((await remove(pending.token)).status, 204);
    assert.equal((await remove(pending.token)).status, 404);

    const kept = await (await upload(server.baseURL, 'kept.txt', Buffer.from('kept'))).json();
    assert.equal((await postEntry(server.baseURL, '<p>with file</p>', [kept])).status, 201);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    assert.deepEqual(await (await fetch(`${server.baseURL}/api/messages`)).json(), []);
    assert.deepEqual(storedFiles(server.root), []);
    assert.equal((await fetch(`${server.baseURL}/${kept.url}`)).status, 404);
  } finally {
    await stopServer(server);
  }
});

test('unsent uploads are private: not downloadable, and only claimable with their token', async () => {
  const server = await startServer();
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const file = await (await upload(server.baseURL, 'secret.txt', Buffer.from('secret'))).json();
    const image = await (await upload(server.baseURL, 'shot.png', png, { type: 'image/png' })).json();
    assert.match(file.token, /^[A-Za-z0-9_-]{32}$/);
    assert.equal((await fetch(`${server.baseURL}/${file.url}`)).status, 404);
    assert.equal((await fetch(`${server.baseURL}/${image.url}`)).status, 404);

    // another client guessing the ids
    const guessed = await fetch(`${server.baseURL}/api/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '<p>mine now</p>', attachments: [{ id: file.id, token: 'guess' }] }),
    });
    assert.equal(guessed.status, 409);
    const withoutToken = await (await postEntry(server.baseURL, `<p>steal</p><img src="${image.url}">`)).json();
    assert.match(withoutToken.message, new RegExp(`api/files/${image.id}/`)); // left unlinked
    assert.equal((await fetch(`${server.baseURL}/${image.url}`)).status, 404);
    assert.equal(countRows(server.root, `SELECT COUNT(*) AS n FROM attachments WHERE message_id IS NULL`), 2);

    // the owner can still send both
    const entry = await (await postEntry(server.baseURL, `<p>ok</p><img src="${image.url}">`, [file], [image])).json();
    assert.equal(entry.files[0].name, 'secret.txt');
    assert.equal((await fetch(`${server.baseURL}/${file.url}`)).status, 200);
    assert.equal((await fetch(`${server.baseURL}/${image.url}`)).status, 200);
  } finally {
    await stopServer(server);
  }
});

test('a file that only claims to be an image is never served inline', async () => {
  const server = await startServer();
  try {
    const fake = await (await upload(server.baseURL, 'fake.png', Buffer.from('<svg onload="alert(1)"></svg>'), { type: 'image/png' })).json();
    assert.equal(fake.type, 'application/octet-stream');
    const entry = await (await postEntry(server.baseURL, `<img src="${fake.url}">`, [fake], [fake])).json();
    assert.equal(entry.files.length, 1);
    const served = await fetch(`${server.baseURL}/${fake.url}`);
    assert.equal(served.headers.get('content-type'), 'application/octet-stream');
    assert.match(served.headers.get('content-disposition'), /^attachment;/);
    const real = await (await upload(server.baseURL, 'name-without-extension', Buffer.from('ffd8ffe000104a464946', 'hex'))).json();
    assert.equal(real.type, 'image/jpeg');
  } finally {
    await stopServer(server);
  }
});

test('a failed database write after an upload leaves no file, row or temporary file behind', async () => {
  const server = await startServer();
  const inject = (sql) => { const db = new DatabaseSync(path.join(server.root, 'database.sqlite')); try { db.exec(sql); } finally { db.close(); } };
  try {
    inject("CREATE TRIGGER fail_files BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'injected'); END");
    const failed = await upload(server.baseURL, 'a.bin', Buffer.alloc(5000, 7));
    assert.equal(failed.status, 500);
    inject('DROP TRIGGER fail_files');

    inject("CREATE TRIGGER fail_entries BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected'); END");
    assert.equal((await upload(server.baseURL, 'b.bin', Buffer.alloc(5000, 8), { route: 'upload' })).status, 500);
    inject('DROP TRIGGER fail_entries');

    assert.deepEqual(storedFiles(server.root), []);
    assert.deepEqual(tmpFiles(server.root), []);
    assert.equal(countRows(server.root, 'SELECT COUNT(*) AS n FROM attachments'), 0);
    assert.equal(countRows(server.root, 'SELECT COUNT(*) AS n FROM messages'), 0);
    assert.equal((await upload(server.baseURL, 'c.bin', Buffer.alloc(5000, 9))).status, 201); // still healthy
  } finally {
    await stopServer(server);
  }
});

test('a terminal upload refused for lack of database space keeps nothing', async () => {
  const server = await startServer({ MAX_DATABASE_BYTES: '1000' });
  try {
    const refused = await upload(server.baseURL, 'big.log', Buffer.alloc(3000, 65), { route: 'upload' });
    assert.equal(refused.status, 413);
    assert.match(await refused.text(), /storage limit reached/);
    assert.deepEqual(storedFiles(server.root), []);
    assert.equal(countRows(server.root, 'SELECT COUNT(*) AS n FROM attachments'), 0);
  } finally {
    await stopServer(server);
  }
});

test('concurrent identical uploads are stored once', async () => {
  const server = await startServer();
  try {
    const content = Buffer.alloc(200000, 3);
    const results = await Promise.all([1, 2, 3].map((n) => upload(server.baseURL, `copy-${n}.bin`, content)));
    assert.deepEqual(results.map((response) => response.status), [201, 201, 201]);
    assert.equal(storedFiles(server.root).length, 1);
    assert.equal((await (await fetch(`${server.baseURL}/api/config`)).json()).filesBytesUsed, content.length);
  } finally {
    await stopServer(server);
  }
});

test('startup removes leftover temporary files and files no entry refers to', async () => {
  const first = await startServer();
  const root = first.root;
  const kept = await (await upload(first.baseURL, 'kept.txt', Buffer.from('kept'))).json();
  assert.equal((await postEntry(first.baseURL, '', [kept])).status, 201);
  first.child.kill('SIGTERM');
  await new Promise((resolve) => first.child.once('exit', resolve));

  const stray = 'ab'.padEnd(64, '0');
  mkdirSync(path.join(root, 'files', 'ab'), { recursive: true });
  writeFileSync(path.join(root, 'files', 'ab', stray), 'orphan');
  writeFileSync(path.join(root, 'files', '.tmp', 'interrupted-upload'), 'partial');
  const server = await startServer({}, root);
  try {
    assert.deepEqual(storedFiles(root), [createHash('sha256').update('kept').digest('hex')]);
    assert.deepEqual(tmpFiles(root), []);
    assert.equal((await fetch(`${server.baseURL}/${kept.url}`)).status, 200);
  } finally {
    await stopServer(server);
  }
});

test('an attachments table from an earlier build is migrated to the constrained schema', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clippy-migrate-'));
  const db = new DatabaseSync(path.join(root, 'database.sqlite'));
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      mono INTEGER NOT NULL DEFAULT 0, deleted_at DATETIME, is_pinned INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER, sha256 TEXT NOT NULL, name TEXT NOT NULL,
      type TEXT NOT NULL, size INTEGER NOT NULL, inline INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO messages (id, message) VALUES (1, '<p>old</p>');
    INSERT INTO attachments (id, message_id, sha256, name, type, size) VALUES (5, 1, '${'c'.repeat(64)}', 'old.txt', 'text/plain', 3);
    INSERT INTO attachments (id, message_id, sha256, name, type, size) VALUES (6, NULL, '${'d'.repeat(64)}', 'unsent.txt', 'text/plain', 3);`);
  db.close();
  const server = await startServer({}, root);
  try {
    const [entry] = await (await fetch(`${server.baseURL}/api/messages`)).json();
    assert.deepEqual(entry.files.map((file) => [file.id, file.name]), [[5, 'old.txt']]);
    const check = new DatabaseSync(path.join(root, 'database.sqlite'));
    try {
      const sql = check.prepare("SELECT sql FROM sqlite_master WHERE name = 'attachments'").get().sql;
      assert.match(sql, /REFERENCES messages/);
      assert.match(sql, /claim_hash/);
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 1);
      assert.throws(() => check.prepare("INSERT INTO attachments (message_id, sha256, name, type, size) VALUES (1, 'not-a-hash', 'x', 'text/plain', 1)").run(), /CHECK/);
      assert.throws(() => check.prepare(`INSERT INTO attachments (message_id, sha256, name, type, size) VALUES (1, '${'e'.repeat(64)}', 'x', 'text/plain', -1)`).run(), /CHECK/);
      assert.throws(() => check.prepare(`INSERT INTO attachments (message_id, sha256, name, type, size) VALUES (NULL, '${'e'.repeat(64)}', 'x', 'text/plain', 1)`).run(), /CHECK/);
    } finally {
      check.close();
    }
  } finally {
    await stopServer(server);
  }
});
