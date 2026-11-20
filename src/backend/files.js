// File attachments are stored outside SQLite, content-addressed by SHA-256:
//   <FILES_PATH>/ab/abcdef…   (identical uploads share one file on disk)
//   <FILES_PATH>/.tmp/<uuid>  (uploads in progress)
// SQLite only keeps metadata (attachments table). Names never reach the file system.

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const SHA256 = /^[0-9a-f]{64}$/;
const HEAD_BYTES = 32; // enough for every image signature checked below

const EXTENSION_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', xml: 'application/xml',
  yaml: 'application/yaml', yml: 'application/yaml', cfg: 'text/plain', conf: 'text/plain', ini: 'text/plain', html: 'text/html', htm: 'text/html',
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed', xz: 'application/x-xz',
  pcap: 'application/vnd.tcpdump.pcap', pcapng: 'application/vnd.tcpdump.pcap', cap: 'application/vnd.tcpdump.pcap',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// Only these are ever served inline (thumbnails / pasted images). Everything else, SVG and HTML included, is a download.
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

function sanitizeFileName(value) {
  const base = String(value ?? '').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^[.\s]+/, '')
    .trim();
  return base.slice(0, 200) || 'file';
}

function guessType(name, declared) {
  const header = String(declared || '').split(';')[0].trim().toLowerCase();
  if (/^[a-z]+\/[a-z0-9.+-]+$/.test(header) && header !== 'application/octet-stream' && header !== 'application/x-www-form-urlencoded') return header;
  const extension = path.extname(name).slice(1).toLowerCase();
  return EXTENSION_TYPES[extension] || 'application/octet-stream';
}

function isInlineImageType(type) {
  return INLINE_IMAGE_TYPES.has(type);
}

// Image type from the first bytes of the content (magic numbers), or null.
function sniffImageType(head) {
  const ascii = (start, end) => head.subarray(start, end).toString('latin1');
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return 'image/gif';
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 12 && ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) return 'image/avif';
  if (head.length >= 18 && ascii(0, 2) === 'BM' && [12, 40, 52, 56, 108, 124].includes(head.readUInt32LE(14))) return 'image/bmp';
  return null;
}

// Stored type: the sniffed image type when the content is an image; a name or header that only
// claims to be an inline image is downgraded to a plain download.
function resolveType(name, declared, head) {
  const sniffed = sniffImageType(head);
  if (sniffed) return sniffed;
  const guessed = guessType(name, declared);
  return isInlineImageType(guessed) ? 'application/octet-stream' : guessed;
}

function contentDisposition(name, inline) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

class FileStore {
  constructor(root) {
    this.root = path.resolve(root); // res.sendFile needs absolute paths
    this.tmpDir = path.join(root, '.tmp');
    this.reservations = new Map(); // tmp path -> maximum writable bytes until commit or discard
  }

  async init() {
    await fsp.mkdir(this.tmpDir, { recursive: true });
    await this.cleanTmp(0); // anything left at startup is from an interrupted upload
  }

  pathFor(sha256) {
    if (!SHA256.test(sha256)) throw new Error('Invalid file hash');
    return path.join(this.root, sha256.slice(0, 2), sha256);
  }

  // Called on the server's write queue, like commit and discard. Unowned temps
  // (including failed unlinks) consume headroom; count owned paths by reservation.
  async reserve(declared, headroom) {
    let available = headroom - await this.tmpBytes(this.reservations);
    for (const bytes of this.reservations.values()) available -= bytes;
    const limitError = this.reservations.size ? httpError(503, 'Upload staging is busy; retry later')
      : httpError(413, 'Upload exceeds available staging space');
    if (declared > available || (available <= 0 && declared !== 0)) throw limitError;
    const maxBytes = Number.isFinite(declared) ? declared : available;
    const tmp = path.join(this.tmpDir, crypto.randomUUID());
    this.reservations.set(tmp, maxBytes);
    return { tmp, maxBytes, limitError };
  }

  // Stream outside the write queue, enforcing the reservation on actual bytes.
  receive(req, { tmp, maxBytes, limitError }) {
    return new Promise((resolve, reject) => {
      if (req.destroyed) return reject(httpError(400, 'Upload interrupted'));
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(tmp, { flags: 'wx' });
      const headChunks = [];
      let headBytes = 0;
      let size = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        req.unpipe(out);
        // Keep the reservation until the writer has closed and discard has run.
        out.once('close', () => reject(error));
        out.destroy();
      };
      req.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          fail(limitError);
          return;
        }
        hash.update(chunk);
        if (headBytes < HEAD_BYTES) {
          headChunks.push(chunk.subarray(0, HEAD_BYTES - headBytes));
          headBytes += Math.min(chunk.length, HEAD_BYTES - headBytes);
        }
      });
      req.on('close', () => { if (!req.complete) fail(httpError(400, 'Upload interrupted')); });
      req.on('error', fail);
      out.on('error', (error) => fail(error.code === 'ENOSPC' ? httpError(507, 'No space left for files') : error));
      out.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve({ tmp, size, sha256: hash.digest('hex'), head: Buffer.concat(headChunks) });
      });
      req.pipe(out);
    });
  }

  async exists(sha256) {
    try {
      await fsp.access(this.pathFor(sha256));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  // null means confirmed missing or non-regular. Inspection errors must reach
  // callers: recovery cannot retire an owner based on an unknown size.
  async readableSize(sha256) {
    try {
      const target = this.pathFor(sha256);
      const stat = await fsp.stat(target);
      if (!stat.isFile()) return null;
      const handle = await fsp.open(target, 'r');
      await handle.close();
      return stat.size;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async isRegularFile(sha256, size) {
    return (await this.readableSize(sha256)) === size;
  }

  async storedSize(sha256) {
    try {
      const stat = await fsp.stat(this.pathFor(sha256));
      if (!stat.isFile()) throw Object.assign(new Error('Stored blob is not a regular file'), { code: 'EFTYPE' });
      return stat.size;
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
  }

  async tmpBytes(exclude = null) {
    let total = 0;
    for (const file of await fsp.readdir(this.tmpDir)) {
      const full = path.join(this.tmpDir, file);
      if (exclude?.has(full)) continue;
      const stat = await fsp.stat(full);
      if (!stat.isFile()) throw new Error('Temp inventory contains a non-regular file');
      total += stat.size;
    }
    return total;
  }

  // Moves an upload into place; if the same content is already stored, the upload is simply dropped.
  async commit(tmp, sha256, size) {
    const target = this.pathFor(sha256);
    if (await this.isRegularFile(sha256, size)) {
      const existing = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(target)) existing.update(chunk);
      if (existing.digest('hex') === sha256) {
        await fsp.rm(tmp, { force: true });
        return false;
      }
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rename(tmp, target);
    return true;
  }

  discard(tmp) {
    return fsp.rm(tmp, { force: true });
  }

  remove(sha256) {
    return fsp.rm(this.pathFor(sha256), { force: true });
  }

  async readHead(sha256) {
    const handle = await fsp.open(this.pathFor(sha256), 'r');
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async listStored() {
    const stored = [];
    let dirs;
    try { dirs = await fsp.readdir(this.root); } catch (error) {
      if (error.code === 'ENOENT') return stored;
      throw error;
    }
    for (const dir of dirs) {
      if (!/^[0-9a-f]{2}$/.test(dir)) continue;
      for (const file of await fsp.readdir(path.join(this.root, dir))) {
        if (!SHA256.test(file) || !file.startsWith(dir)) continue;
        const stat = await fsp.stat(path.join(this.root, dir, file));
        if (stat?.isFile()) stored.push({ sha256: file, size: stat.size });
      }
    }
    return stored;
  }

  // Deletes stored files whose hash is not in `keep`. Returns the number of files removed.
  async sweep(keep) {
    let removed = 0;
    let dirs;
    try {
      dirs = await fsp.readdir(this.root);
    } catch {
      return 0;
    }
    for (const dir of dirs) {
      if (!/^[0-9a-f]{2}$/.test(dir)) continue;
      const files = await fsp.readdir(path.join(this.root, dir)).catch(() => []);
      for (const file of files) {
        if (SHA256.test(file) && file.startsWith(dir) && !keep.has(file)) {
          await fsp.rm(path.join(this.root, dir, file), { force: true });
          removed += 1;
        }
      }
    }
    return removed;
  }

  async cleanTmp(maxAgeMs) {
    const now = Date.now();
    const files = await fsp.readdir(this.tmpDir).catch(() => []);
    for (const file of files) {
      const full = path.join(this.tmpDir, file);
      if (this.reservations.has(full)) continue;
      try {
        const stat = await fsp.stat(full);
        if (now - stat.mtimeMs >= maxAgeMs) await fsp.rm(full, { force: true });
      } catch (error) {
        // Best effort only: tmpBytes still inventories stranded files for admission.
        if (error.code !== 'ENOENT') console.warn('Temp cleanup deferred:', error.message);
      }
    }
  }
}

module.exports = { FileStore, sanitizeFileName, guessType, isInlineImageType, sniffImageType, resolveType, contentDisposition, httpError };
