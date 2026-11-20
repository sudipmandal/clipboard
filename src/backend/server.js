const crypto = require('crypto');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { parseDuration, formatDuration, formatBytes, plainTextToHtml, htmlToPlainText } = require('./text');
const { FileStore, sanitizeFileName, isInlineImageType, sniffImageType, resolveType, contentDisposition, httpError } = require('./files');

const app = express();
const port = positiveInteger(process.env.PORT, 3000);
const dbFilePath = process.env.DATABASE_PATH || '/data/database.sqlite';
const LEGACY_DATABASE_PATH = process.env.LEGACY_DATABASE_PATH || '/database.sqlite';
const packagedDistPath = path.resolve(__dirname, '../dist');
const sourceDistPath = path.resolve(__dirname, '../../dist');
const distPath = process.env.DIST_PATH || (fs.existsSync(packagedDistPath) ? packagedDistPath : sourceDistPath);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_IMAGE_BYTES = positiveInteger(process.env.MAX_IMAGE_BYTES, 5 * 1024 * 1024);
const MAX_ENTRY_BYTES = positiveInteger(process.env.MAX_ENTRY_BYTES, 10 * 1024 * 1024);
const MAX_DATABASE_BYTES = positiveInteger(process.env.MAX_DATABASE_BYTES, 250 * 1024 * 1024);
const SQLITE_WRITE_OVERHEAD_BYTES = 64 * 1024;
const DEFAULT_RETENTION = '0'; // keep forever unless RETENTION_TIME is set
const RETENTION_SECONDS = resolveRetention(process.env.RETENTION_TIME);
const PURGE_INTERVAL_MS = positiveInteger(process.env.PURGE_INTERVAL_MS, 60 * 60 * 1000);
const RESTORE_WINDOW_SECONDS = positiveInteger(process.env.RESTORE_WINDOW_SECONDS, 8);
const DELETED_ENTRY_PURGE_SECONDS = 10 * 60; // keep deleted data briefly for cleanup, but restore only during the UI undo window
const ENTRY_COLUMNS = "id, message, mono, is_pinned, strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at";
// Files (attachments and pasted images) live on disk next to the database, not inside it.
const FILES_PATH = process.env.FILES_PATH || path.join(path.dirname(dbFilePath), 'files');
const MAX_FILE_BYTES = positiveInteger(process.env.MAX_FILE_BYTES, 100 * 1024 * 1024);
const MAX_FILES_BYTES = positiveInteger(process.env.MAX_FILES_BYTES, 5 * 1024 * 1024 * 1024);
const MAX_FILES_PER_ENTRY = positiveInteger(process.env.MAX_FILES_PER_ENTRY, 20);
const PENDING_UPLOAD_SECONDS = 24 * 60 * 60; // uploaded in the composer but never sent
const fileStore = new FileStore(FILES_PATH);

function resolveRetention(value) {
  if (value === undefined || String(value).trim() === '') return parseDuration(DEFAULT_RETENTION);
  const seconds = parseDuration(value);
  if (seconds !== null) return seconds;
  console.warn(`Invalid RETENTION_TIME "${value}" (use e.g. 10d, 36h, 90m, 0 to disable); using ${DEFAULT_RETENTION}`);
  return parseDuration(DEFAULT_RETENTION);
}

fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
if (!fs.existsSync(dbFilePath) && fs.existsSync(LEGACY_DATABASE_PATH)) {
  fs.copyFileSync(LEGACY_DATABASE_PATH, dbFilePath, fs.constants.COPYFILE_EXCL);
}

const db = new sqlite3.Database(dbFilePath);
let writeQueue = Promise.resolve();

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) { if (error) reject(error); else resolve(this); });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row))));
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows))));
}

async function initDatabase() {
  await run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  const columns = (await all('PRAGMA table_info(messages)')).map((column) => column.name);
  if (!columns.includes('mono')) await run('ALTER TABLE messages ADD COLUMN mono INTEGER NOT NULL DEFAULT 0');
  if (!columns.includes('deleted_at')) await run('ALTER TABLE messages ADD COLUMN deleted_at DATETIME');
  if (!columns.includes('is_pinned')) await run('ALTER TABLE messages ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0');
  await migrateAttachments();
  await run(`CREATE TABLE IF NOT EXISTS file_deletions (
    sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    size INTEGER NOT NULL CHECK (size >= 0),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await run('PRAGMA foreign_keys = ON'); // attachments follow their entry when it is purged
  await fileStore.init();
  await recordOrphanFiles();
  await reconcileFileDeletions();
}

// message_id NULL = uploaded in the composer, not sent yet; such a row can only be claimed with the
// token returned by the upload (claim_hash = its SHA-256). inline = image shown inside the entry text.
const ATTACHMENTS_SCHEMA = `CREATE TABLE attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER REFERENCES messages (id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
    type TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    inline INTEGER NOT NULL DEFAULT 0 CHECK (inline IN (0, 1)),
    claim_hash TEXT CHECK (claim_hash IS NULL OR length(claim_hash) = 64),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CHECK (message_id IS NOT NULL OR claim_hash IS NOT NULL)
  )`;

// Creates the attachments table, or rebuilds one created without constraints and claim tokens.
async function migrateAttachments() {
  const existing = await get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attachments'");
  if (!existing) {
    await run(ATTACHMENTS_SCHEMA);
  } else if (!existing.sql.includes('claim_hash')) {
    await run('BEGIN IMMEDIATE');
    try {
      await run('ALTER TABLE attachments RENAME TO attachments_old');
      await run(ATTACHMENTS_SCHEMA);
      // Unsent uploads of the old schema have no claim token: only files linked to an entry are kept.
      await run(`INSERT INTO attachments (id, message_id, sha256, name, type, size, inline, created_at)
        SELECT id, message_id, sha256, substr(name, 1, 255), type, size, inline, created_at FROM attachments_old
        WHERE message_id IN (SELECT id FROM messages) AND length(sha256) = 64 AND size >= 0`);
      await run('DROP TABLE attachments_old');
      await run('COMMIT');
    } catch (error) {
      await run('ROLLBACK').catch(() => {});
      throw error;
    }
  }
  await run('CREATE INDEX IF NOT EXISTS attachments_message ON attachments (message_id)');
  await run('CREATE INDEX IF NOT EXISTS attachments_sha256 ON attachments (sha256)');
}

// Runs inside enqueueWrite: all writes share one connection and are serialized.
async function inTransaction(work) {
  await run('BEGIN IMMEDIATE');
  try {
    const result = await work();
    await run('COMMIT');
    return result;
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    throw error;
  }
}

function newClaimToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function tokenMatches(hash, token) {
  if (!hash || typeof token !== 'string' || !token) return false;
  const expected = Buffer.from(hash, 'hex');
  const given = Buffer.from(tokenHash(token), 'hex');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// [{ id, token }] from a request body; anything else is ignored.
function parseClaims(value) {
  const claims = new Map();
  for (const item of Array.isArray(value) ? value : []) {
    const id = Number(item?.id);
    if (Number.isSafeInteger(id) && id > 0 && typeof item?.token === 'string') claims.set(id, item.token);
  }
  return [...claims].map(([id, token]) => ({ id, token }));
}

async function verifyClaims(claims) {
  for (const { id, token } of claims) {
    const row = await get('SELECT sha256, size, claim_hash FROM attachments WHERE id = ? AND message_id IS NULL', [id]);
    if (!row || !tokenMatches(row.claim_hash, token) || !(await fileStore.isRegularFile(row.sha256, row.size))) {
      throw httpError(409, 'An attached file is no longer available, attach it again');
    }
  }
}

async function finishDeletionIntent(sha256) {
  await fileStore.remove(sha256);
  await inTransaction(async () => {
    await run('DELETE FROM attachments WHERE sha256 = ? AND message_id IS NULL', [sha256]);
    await run('DELETE FROM file_deletions WHERE sha256 = ?', [sha256]);
  });
}

async function reconcileFileDeletions() {
  const intents = await all('SELECT sha256 FROM file_deletions ORDER BY created_at, sha256');
  for (const { sha256 } of intents) {
    try { await finishDeletionIntent(sha256); } catch (error) { console.error(`File deletion retry failed for ${sha256}:`, error.message); }
  }
}

async function recordOrphanFiles() {
  for (const { sha256, size } of await fileStore.listStored()) {
    const referenced = await get('SELECT 1 AS found FROM attachments WHERE sha256 = ? LIMIT 1', [sha256]);
    if (!referenced) await run('INSERT OR IGNORE INTO file_deletions (sha256, size) VALUES (?, ?)', [sha256, size]);
  }
}

async function deletePendingUpload(id, token) {
  return enqueueWrite(async () => {
    const row = await get('SELECT sha256, claim_hash FROM attachments WHERE id = ? AND message_id IS NULL', [id]);
    if (!row || !tokenMatches(row.claim_hash, token)) return false;
    const shared = await get('SELECT 1 AS found FROM attachments WHERE sha256 = ? AND id != ? LIMIT 1', [row.sha256, id]);
    if (shared) await run('DELETE FROM attachments WHERE id = ? AND message_id IS NULL', [id]);
    else {
      await run('INSERT OR IGNORE INTO file_deletions (sha256, size) SELECT sha256, size FROM attachments WHERE id = ?', [id]);
      await finishDeletionIntent(row.sha256);
    }
    return true;
  });
}

function enqueueWrite(task) {
  const queued = writeQueue.then(task);
  writeQueue = queued.catch(() => {});
  return queued;
}

function enqueueRead(task) {
  const queued = writeQueue.then(task);
  writeQueue = queued.catch(() => {});
  return queued;
}

function toEntry(row, files = []) {
  return { id: row.id, message: row.message, mono: Boolean(row.mono), is_pinned: Boolean(row.is_pinned), created_at: row.created_at, files };
}

function fileUrl(id, name) {
  return `api/files/${id}/${encodeURIComponent(name)}`;
}

function toFile(row) {
  return { id: row.id, name: row.name, type: row.type, size: row.size, url: fileUrl(row.id, row.name) };
}

// Attached files (not inline images) of the given entries, grouped by entry id.
async function filesByEntry(ids) {
  const grouped = new Map();
  if (!ids.length) return grouped;
  const rows = await all(
    `SELECT id, message_id, name, type, size FROM attachments WHERE inline = 0 AND message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    ids,
  );
  for (const row of rows) {
    if (!grouped.has(row.message_id)) grouped.set(row.message_id, []);
    grouped.get(row.message_id).push(toFile(row));
  }
  return grouped;
}

async function loadEntry(id) {
  const row = await get(`SELECT ${ENTRY_COLUMNS} FROM messages WHERE id = ?`, [id]);
  if (!row) return null;
  return toEntry(row, (await filesByEntry([id])).get(id) || []);
}

// Each distinct file is counted once, whatever the number of entries pointing to it.
async function filesBytesUsed() {
  const rows = await all('SELECT sha256, size FROM attachments UNION ALL SELECT sha256, size FROM file_deletions');
  const bytesByHash = new Map();
  for (const { sha256, size } of [...rows, ...await fileStore.listStored()]) {
    bytesByHash.set(sha256, Math.max(bytesByHash.get(sha256) || 0, size));
  }
  return [...bytesByHash.values()].reduce((total, size) => total + size, 0);
}

// <img src="api/files/<id>/…"> (relative or absolute) inside entry HTML.
const INLINE_FILE_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(?:[^"']*?\/)?api\/files\/(\d+)\/[^"']*\2/gi;

// Links the claimed uploads to a new entry: attachments as files, inlineUploads as images referenced by the HTML.
// An image copied from another entry gets its own attachment row so each entry owns what it shows.
// Another client's unsent upload is never linked, even if its id appears in the HTML.
async function linkFiles(messageId, html, attachments, inlineUploads) {
  for (const { id } of attachments) {
    await run('UPDATE attachments SET message_id = ?, inline = 0, claim_hash = NULL WHERE id = ? AND message_id IS NULL', [messageId, id]);
  }
  const claimedInline = new Set(inlineUploads.map((claim) => claim.id));
  const referenced = [...new Set([...html.matchAll(INLINE_FILE_SRC)].map((match) => Number(match[3])))];
  const remap = new Map();
  for (const fileId of referenced) {
    const row = await get('SELECT id, message_id, sha256, name, type, size FROM attachments WHERE id = ?', [fileId]);
    if (!row || !isInlineImageType(row.type)) continue;
    if (row.message_id === null) {
      if (!claimedInline.has(fileId)) continue;
      await run('UPDATE attachments SET message_id = ?, inline = 1, claim_hash = NULL WHERE id = ?', [messageId, row.id]);
      remap.set(fileId, row);
    } else if (row.message_id !== messageId) {
      const copy = await run(
        'INSERT INTO attachments (message_id, sha256, name, type, size, inline) VALUES (?, ?, ?, ?, ?, 1)',
        [messageId, row.sha256, row.name, row.type, row.size],
      );
      remap.set(fileId, { ...row, id: copy.lastID });
    }
  }
  if (!remap.size) return html;
  return html.replace(INLINE_FILE_SRC, (match, prefix, quote, fileId) => {
    const row = remap.get(Number(fileId));
    return row ? `${prefix}${quote}${fileUrl(row.id, row.name)}${quote}` : match;
  });
}

function entryId(value) {
  return /^\d+$/.test(value) ? Number(value) : null;
}

// Inserts an entry with its files. Must run inside enqueueWrite + inTransaction; throws httpError on refusal.
async function writeEntry(html, mono, attachments, inlineUploads) {
  let currentDatabaseBytes;
  try {
    currentDatabaseBytes = databaseBytes();
  } catch {
    throw httpError(500, 'Unable to inspect storage');
  }
  if (currentDatabaseBytes + Buffer.byteLength(html, 'utf8') + SQLITE_WRITE_OVERHEAD_BYTES > MAX_DATABASE_BYTES) {
    throw httpError(413, 'Clipboard storage limit reached');
  }
  await verifyClaims([...attachments, ...inlineUploads]);
  const result = await run('INSERT INTO messages (message, mono) VALUES (?, ?)', [html, mono ? 1 : 0]);
  const linkedHtml = await linkFiles(result.lastID, html, attachments, inlineUploads);
  if (linkedHtml !== html) await run('UPDATE messages SET message = ? WHERE id = ?', [linkedHtml, result.lastID]);
  const linked = await get('SELECT COUNT(*) AS n FROM attachments WHERE message_id = ?', [result.lastID]);
  if (linked.n > MAX_FILES_PER_ENTRY) throw httpError(400, `At most ${MAX_FILES_PER_ENTRY} files per entry`);
  return result.lastID;
}

// Validates, then writes the entry and links its files in one transaction. Returns { status, entry } or { status, error }.
async function insertEntry(html, mono, attachments = [], inlineUploads = []) {
  if (!html.trim() && !attachments.length) return { status: 400, error: 'Entry content is required' };
  const claimedFiles = new Set([...attachments, ...inlineUploads].map((claim) => claim.id));
  if (claimedFiles.size > MAX_FILES_PER_ENTRY) return { status: 400, error: `At most ${MAX_FILES_PER_ENTRY} files per entry` };
  if (Buffer.byteLength(html, 'utf8') > MAX_ENTRY_BYTES) return { status: 413, error: 'Entry is too large' };
  if (hasOversizedImage(html)) return { status: 413, error: 'An embedded image is too large' };
  try {
    const entry = await enqueueWrite(async () => {
      const id = await inTransaction(() => writeEntry(html, mono, attachments, inlineUploads));
      return loadEntry(id);
    });
    return { status: 201, entry };
  } catch (error) {
    return { status: error.status || 500, error: error.status ? error.message : 'Unable to save entry' };
  }
}

// Expired entries (RETENTION_TIME) and soft-deleted entries past the undo window are removed, then the file is compacted.
function purgeExpired() {
  return enqueueWrite(async () => {
    let removed = 0;
    await inTransaction(async () => {
      const retentionClause = RETENTION_SECONDS > 0
        ? "(m.created_at < datetime('now', ?) AND m.is_pinned = 0) OR "
        : '';
      const retentionParams = RETENTION_SECONDS > 0 ? [`-${RETENTION_SECONDS} seconds`] : [];
      await run(`INSERT OR IGNORE INTO file_deletions (sha256, size)
        SELECT a.sha256, MAX(a.size) FROM attachments a
        WHERE (
          a.message_id IN (SELECT m.id FROM messages m WHERE ${retentionClause}(m.deleted_at IS NOT NULL AND julianday(m.deleted_at) < julianday('now', ?)))
          OR (a.message_id IS NULL AND julianday(a.created_at) < julianday('now', ?))
        )
        AND NOT EXISTS (
          SELECT 1 FROM attachments keep
          WHERE keep.sha256 = a.sha256 AND NOT (
            keep.message_id IN (SELECT m.id FROM messages m WHERE ${retentionClause}(m.deleted_at IS NOT NULL AND julianday(m.deleted_at) < julianday('now', ?)))
            OR (keep.message_id IS NULL AND julianday(keep.created_at) < julianday('now', ?))
          )
        ) GROUP BY a.sha256`, [
        ...retentionParams, `-${DELETED_ENTRY_PURGE_SECONDS} seconds`, `-${PENDING_UPLOAD_SECONDS} seconds`,
        ...retentionParams, `-${DELETED_ENTRY_PURGE_SECONDS} seconds`, `-${PENDING_UPLOAD_SECONDS} seconds`,
      ]);
      if (RETENTION_SECONDS > 0) {
        removed += (await run("DELETE FROM messages WHERE created_at < datetime('now', ?) AND is_pinned = 0", [`-${RETENTION_SECONDS} seconds`])).changes;
      }
      removed += (await run("DELETE FROM messages WHERE deleted_at IS NOT NULL AND julianday(deleted_at) < julianday('now', ?)", [`-${DELETED_ENTRY_PURGE_SECONDS} seconds`])).changes;
      await run('DELETE FROM attachments WHERE message_id IS NOT NULL AND message_id NOT IN (SELECT id FROM messages)');
      await run("DELETE FROM attachments WHERE message_id IS NULL AND julianday(created_at) < julianday('now', ?)", [`-${PENDING_UPLOAD_SECONDS} seconds`]);
    });
    await reconcileFileDeletions();
    const keep = new Set((await all('SELECT sha256 FROM attachments UNION SELECT sha256 FROM file_deletions')).map((row) => row.sha256));
    const removedFiles = await fileStore.sweep(keep);
    await fileStore.cleanTmp(PENDING_UPLOAD_SECONDS * 1000);
    if (removed) {
      await run('VACUUM');
      console.log(`Purged ${removed} expired or deleted entr${removed === 1 ? 'y' : 'ies'}`);
    }
    if (removedFiles) console.log(`Removed ${removedFiles} unreferenced file${removedFiles === 1 ? '' : 's'}`);
  }).catch((error) => console.error('Purge failed:', error));
}

function decodedDataUriBytes(payload) {
  const comma = payload.indexOf(',');
  if (comma < 0) return Number.POSITIVE_INFINITY;
  const metadata = payload.slice(0, comma);
  const data = payload.slice(comma + 1);
  if (/;base64$/i.test(metadata)) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) return Number.POSITIVE_INFINITY;
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    return Math.floor((data.length * 3) / 4) - padding;
  }
  try {
    return Buffer.byteLength(decodeURIComponent(data), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function decodeHtmlCharacterReferences(value) {
  return value
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (match, hex, decimal) => {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    })
    .replace(/&colon;/gi, ':');
}

function hasOversizedImage(text) {
  const imageTags = text.match(/<img\b[^>]*>/gi) || [];
  return imageTags.some((tag) => {
    const sourceMatch = tag.match(/\bsrc\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i);
    const source = decodeHtmlCharacterReferences(sourceMatch?.[2] || sourceMatch?.[3] || '');
    return source.toLowerCase().startsWith('data:image/') && decodedDataUriBytes(source) > MAX_IMAGE_BYTES;
  });
}

function databaseBytes() {
  return ['', '-wal', '-shm'].reduce((total, suffix) => {
    try {
      return total + fs.statSync(`${dbFilePath}${suffix}`).size;
    } catch (error) {
      if (error.code === 'ENOENT') return total;
      throw error;
    }
  }, 0);
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  next();
});
// Plain-text push for terminals:  some-command | curl -sk -T - https://<host>/clipboard/api/text
// Registered before the JSON parser so any Content-Type is taken as raw text.
const textBody = express.text({ type: () => true, limit: MAX_ENTRY_BYTES });
async function pushText(req, res) {
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text.trim()) return res.status(400).type('text/plain').send('Entry content is required\n');
  const result = await insertEntry(plainTextToHtml(text), true);
  if (result.error) return res.status(result.status).type('text/plain').send(`${result.error}\n`);
  return res.status(201).type('text/plain').send(`#${result.entry.id}\n`);
}
app.put('/api/text', textBody, pushText);

// File uploads are raw PUT bodies streamed to disk (no multipart: a cross-site form cannot send a PUT).
//   PUT /api/files/<name>   composer upload, returns a pending attachment (JSON), linked when the entry is sent
//   PUT /api/upload/<name>  terminal upload, creates an entry holding the file and prints "#<id>"
//                           curl -sk -T capture.pcap https://<host>/clipboard/api/upload/
async function receiveUpload(req) {
  const name = sanitizeFileName(req.params.name);
  const declared = Number.parseInt(req.headers['content-length'], 10);
  if (declared > MAX_FILE_BYTES) throw httpError(413, `File is larger than the ${formatBytes(MAX_FILE_BYTES)} limit`);
  // The total-storage check happens after hashing: an identical file already stored takes no extra space.
  let upload;
  try {
    upload = await fileStore.receive(req, MAX_FILE_BYTES);
  } catch (error) {
    if (error.status === 413) throw httpError(413, `File is larger than the ${formatBytes(MAX_FILE_BYTES)} limit`);
    throw error;
  }
  return { upload, name, type: resolveType(name, req.headers['content-type'], upload.head) };
}

// Stores an upload atomically: rows are written in a transaction and the file is moved into place as the
// last step before COMMIT; if anything fails, the transaction is rolled back and a newly added file removed.
// createEntry: terminal upload, the entry is created first and the file row is born linked to it.
// Otherwise the row stays unsent and can only be claimed (or deleted) with the returned token.
function storeUpload({ upload, name, type }, createEntry) {
  return enqueueWrite(async () => {
    let added = false;
    try {
      if (await get('SELECT 1 AS found FROM file_deletions WHERE sha256 = ?', [upload.sha256])) {
        await finishDeletionIntent(upload.sha256);
      }
      return await inTransaction(async () => {
        if (!(await fileStore.isRegularFile(upload.sha256, upload.size)) && (await filesBytesUsed()) + upload.size > MAX_FILES_BYTES) {
          throw httpError(413, `File storage is full (${formatBytes(MAX_FILES_BYTES)})`);
        }
        const messageId = createEntry ? await writeEntry('', false, [], []) : null;
        const token = createEntry ? null : newClaimToken();
        const row = await run(
          'INSERT INTO attachments (message_id, sha256, name, type, size, claim_hash) VALUES (?, ?, ?, ?, ?, ?)',
          [messageId, upload.sha256, name, type, upload.size, token && tokenHash(token)],
        );
        added = await fileStore.commit(upload.tmp, upload.sha256, upload.size);
        return { id: row.lastID, token, messageId, name, type, size: upload.size, url: fileUrl(row.lastID, name) };
      });
    } catch (error) {
      await fileStore.discard(upload.tmp);
      if (added && !(await get('SELECT 1 AS found FROM attachments WHERE sha256 = ?', [upload.sha256]))) {
        await run('INSERT OR IGNORE INTO file_deletions (sha256, size) VALUES (?, ?)', [upload.sha256, upload.size]);
        try { await finishDeletionIntent(upload.sha256); } catch (cleanupError) { console.error('Uploaded file cleanup deferred:', cleanupError.message); }
      }
      throw error;
    }
  });
}

function uploadFailed(res, error) {
  res.set('Connection', 'close'); // stop reading the rest of a rejected body
  return { status: error.status || 500, message: error.status ? error.message : 'Unable to store file' };
}

app.put('/api/files/:name', async (req, res) => {
  try {
    const stored = await storeUpload(await receiveUpload(req), false);
    const { id, token, name, type, size, url } = stored;
    return res.status(201).json({ id, token, name, type, size, url });
  } catch (error) {
    const failure = uploadFailed(res, error);
    return res.status(failure.status).json({ error: failure.message });
  }
});

app.put('/api/upload/:name', async (req, res) => {
  try {
    const stored = await storeUpload(await receiveUpload(req), true);
    return res.status(201).type('text/plain').send(`#${stored.messageId}\n`);
  } catch (error) {
    const failure = uploadFailed(res, error);
    return res.status(failure.status).type('text/plain').send(`${failure.message}\n`);
  }
});

// Downloads: safe image types inline (thumbnails, pasted images), everything else as an attachment.
async function sendStoredFile(req, res, row) {
  if (!row) return res.status(404).type('text/plain').send('File not found\n');
  let inline = isInlineImageType(row.type) && req.query.download === undefined;
  if (inline) {
    try {
      inline = sniffImageType(await fileStore.readHead(row.sha256)) === row.type; // the bytes must really be that image
    } catch {
      inline = false;
    }
  }
  res.set({
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Content-Disposition': contentDisposition(row.name, inline),
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  });
  res.type(inline ? row.type : 'application/octet-stream');
  return res.sendFile(fileStore.pathFor(row.sha256), { cacheControl: false, lastModified: false }, (error) => {
    if (error && !res.headersSent) res.status(404).type('text/plain').send('File not found\n');
  });
}

// Only files of visible entries are served; unsent uploads are private to the composer that sent them.
const VISIBLE_FILE = `SELECT a.id, a.sha256, a.name, a.type, a.size FROM attachments a JOIN messages m ON m.id = a.message_id
  WHERE m.deleted_at IS NULL`;

app.get('/api/files/:id/:name', async (req, res) => {
  const id = entryId(req.params.id);
  if (id === null) return res.status(404).type('text/plain').send('File not found\n');
  return sendStoredFile(req, res, await enqueueRead(() => get(`${VISIBLE_FILE} AND a.id = ?`, [id])));
});

// Terminal download of the n-th file of an entry:  curl -skOJ https://<host>/clipboard/api/messages/12/files/1
app.get('/api/messages/:id/files/:index', async (req, res) => {
  const id = entryId(req.params.id);
  const index = entryId(req.params.index);
  if (id === null || !index) return res.status(404).type('text/plain').send('File not found\n');
  return sendStoredFile(req, res, await enqueueRead(() => get(`${VISIBLE_FILE} AND a.message_id = ? AND a.inline = 0 ORDER BY a.id LIMIT 1 OFFSET ?`, [id, index - 1])));
});

// Removes a composer upload that was not sent (the chip's ✕ button); needs its token in X-Upload-Token.
app.delete('/api/files/:id', async (req, res) => {
  const id = entryId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'File not found' });
  return (await deletePendingUpload(id, req.get('x-upload-token')))
    ? res.status(204).send()
    : res.status(404).json({ error: 'File not found' });
});

app.use(express.json({ limit: MAX_ENTRY_BYTES }));
app.use(express.static(distPath, {
  setHeaders(response, filePath) {
    if (filePath.endsWith('.html')) response.setHeader('Cache-Control', 'no-cache');
    else if (filePath.includes(`${path.sep}assets${path.sep}`)) response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.get('/api/config', async (req, res) => {
  let filesBytesUsedNow = null;
  try { filesBytesUsedNow = await enqueueRead(() => filesBytesUsed()); } catch { /* reported as unknown */ }
  res.set('Cache-Control', 'no-store');
  return res.json({
    retentionSeconds: RETENTION_SECONDS,
    retention: formatDuration(RETENTION_SECONDS),
    maxFileBytes: MAX_FILE_BYTES,
    maxFilesBytes: MAX_FILES_BYTES,
    filesBytesUsed: filesBytesUsedNow,
    maxFilesPerEntry: MAX_FILES_PER_ENTRY,
  });
});

app.get('/api/messages', async (req, res) => {
  try {
    const { rows, files } = await enqueueRead(async () => {
      const rows = await all(`SELECT ${ENTRY_COLUMNS} FROM messages WHERE deleted_at IS NULL ORDER BY is_pinned DESC, id DESC`);
      return { rows, files: await filesByEntry(rows.map((row) => row.id)) };
    });
    return res.json(rows.map((row) => toEntry(row, files.get(row.id) || [])));
  } catch {
    return res.status(500).json({ error: 'Unable to load entries' });
  }
});

app.post('/api/messages', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  // attachments / inlineUploads: [{ id, token }] as returned by PUT /api/files/<name>
  const result = await insertEntry(text, req.body?.mono === true, parseClaims(req.body?.attachments), parseClaims(req.body?.inlineUploads));
  if (result.error) return res.status(result.status).json({ error: result.error });
  return res.status(result.status).json(result.entry);
});

// Plain-text pull:  curl -sk https://<host>/clipboard/api/latest.txt   or   .../api/messages/<id>.txt
// Absolute base URL as seen by the client, including a reverse-proxy prefix (Traefik StripPrefix sets X-Forwarded-Prefix).
function publicBase(req) {
  const first = (value) => String(value || '').split(',')[0].trim();
  const proto = first(req.get('x-forwarded-proto')) || req.protocol;
  const host = first(req.get('x-forwarded-host')) || req.get('host');
  const prefix = first(req.get('x-forwarded-prefix')).replace(/\/+$/, '');
  return `${proto}://${host}${prefix}/`;
}

async function sendEntryText(req, res, sql, params) {
  try {
    const { row, files } = await enqueueRead(async () => {
      const row = await get(sql, params);
      return { row, files: row ? (await filesByEntry([row.id])).get(row.id) || [] : [] };
    });
    res.set('Cache-Control', 'no-store');
    if (!row) return res.status(404).type('text/plain').send('Entry not found\n');
    const text = htmlToPlainText(row.message);
    const fileLines = files.map((file) => `[file] ${file.name} (${formatBytes(file.size)}) ${publicBase(req)}${file.url}`);
    return res.type('text/plain').send(`${[text, ...fileLines].filter(Boolean).join('\n')}\n`);
  } catch {
    return res.status(500).type('text/plain').send('Unable to load entry\n');
  }
}
app.get('/api/latest.txt', (req, res) => sendEntryText(req, res, 'SELECT id, message FROM messages WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1', []));
app.get('/api/messages/:file', (req, res, next) => {
  const match = /^(\d+)\.txt$/.exec(req.params.file);
  if (!match) return next();
  return sendEntryText(req, res, 'SELECT id, message FROM messages WHERE id = ? AND deleted_at IS NULL', [Number(match[1])]);
});

app.patch('/api/messages/:id', async (req, res) => {
  const id = entryId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Invalid entry id' });
  if (typeof req.body?.mono !== 'boolean' && typeof req.body?.is_pinned !== 'boolean') return res.status(400).json({ error: 'Expected boolean mono or is_pinned' });
  try {
    const updates = [];
    const params = [];
    if (typeof req.body.mono === 'boolean') { updates.push('mono = ?'); params.push(req.body.mono ? 1 : 0); }
    if (typeof req.body.is_pinned === 'boolean') { updates.push('is_pinned = ?'); params.push(req.body.is_pinned ? 1 : 0); }
    params.push(id);
    const entry = await enqueueWrite(async () => {
      const result = await run(`UPDATE messages SET ${updates.join(', ')} WHERE id = ? AND deleted_at IS NULL`, params);
      return result.changes ? loadEntry(id) : null;
    });
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    return res.json(entry);
  } catch {
    return res.status(500).json({ error: 'Unable to update entry' });
  }
});

// Soft delete: the entry disappears immediately but can be restored during the undo window.
app.delete('/api/messages/:id', async (req, res) => {
  const id = entryId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Invalid entry id' });
  try {
    const result = await enqueueWrite(() => run("UPDATE messages SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND deleted_at IS NULL", [id]));
    if (!result.changes) return res.status(404).json({ error: 'Entry not found' });
    return res.status(204).send();
  } catch {
    return res.status(500).json({ error: 'Unable to delete entry' });
  }
});

app.put('/api/messages/:id/restore', async (req, res) => {
  const id = entryId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Invalid entry id' });
  try {
    const entry = await enqueueWrite(async () => {
      const result = await run(
        "UPDATE messages SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL AND julianday(deleted_at) > julianday('now', ?)",
        [id, `-${RESTORE_WINDOW_SECONDS} seconds`],
      );
      return result.changes ? loadEntry(id) : null;
    });
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    return res.json(entry);
  } catch {
    return res.status(500).json({ error: 'Unable to restore entry' });
  }
});

app.use((error, req, res, next) => {
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Entry is too large' });
  return next(error);
});

app.get('*path', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  return res.sendFile(path.join(distPath, 'index.html'));
});

initDatabase()
  .then(async () => {
    await purgeExpired();
    setInterval(purgeExpired, PURGE_INTERVAL_MS).unref();
    app.listen(port, () => console.log(
      `Clippy listening on port ${port} (retention ${formatDuration(RETENTION_SECONDS)}, files up to ${formatBytes(MAX_FILE_BYTES)} each, ${formatBytes(MAX_FILES_BYTES)} total in ${FILES_PATH})`,
    ));
  })
  .catch((error) => {
    console.error('Unable to initialise the database:', error);
    process.exit(1);
  });
