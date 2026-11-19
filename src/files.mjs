// Front-end helpers for file attachments: upload with progress, sizes, icons.

// 104857600 -> "100 MB", 1572864 -> "1.5 MB"
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 || value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'];

export function isInlineImage(type) {
  return INLINE_IMAGE_TYPES.includes(type);
}

export function fileIcon(type = '', name = '') {
  const extension = name.split('.').pop().toLowerCase();
  if (type.startsWith('image/')) return 'bi-file-earmark-image';
  if (type === 'application/pdf') return 'bi-file-earmark-pdf';
  if (type.includes('pcap') || ['pcap', 'pcapng', 'cap'].includes(extension)) return 'bi-ethernet';
  if (/zip|gzip|x-tar|7z|x-xz|compressed/.test(type) || ['zip', 'gz', 'tgz', 'tar', '7z', 'xz', 'bz2'].includes(extension)) return 'bi-file-earmark-zip';
  if (/json|xml|yaml|html|javascript/.test(type) || ['py', 'sh', 'js', 'ts', 'json', 'xml', 'yml', 'yaml', 'html'].includes(extension)) return 'bi-file-earmark-code';
  if (type.startsWith('text/') || ['txt', 'log', 'cfg', 'conf', 'ini', 'md', 'csv'].includes(extension)) return 'bi-file-earmark-text';
  if (type.startsWith('audio/')) return 'bi-file-earmark-music';
  if (type.startsWith('video/')) return 'bi-file-earmark-play';
  if (/spreadsheet|ms-excel/.test(type)) return 'bi-file-earmark-spreadsheet';
  if (/wordprocessing|msword/.test(type)) return 'bi-file-earmark-word';
  if (/presentation|powerpoint/.test(type)) return 'bi-file-earmark-ppt';
  return 'bi-file-earmark-binary';
}

// PUT the raw file to api/files/<name>; resolves to the unsent upload { id, token, name, type, size, url }.
// The token is the only way to attach (or delete) it: keep it with the upload, never display it.
// XMLHttpRequest instead of fetch because only XHR reports upload progress.
export function uploadFile(blob, name, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('PUT', `api/files/${encodeURIComponent(name)}`);
    if (blob.type) xhr.setRequestHeader('Content-Type', blob.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 201 && body?.id) resolve(body);
      else reject(new Error(body?.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed (network error)'));
    xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { cancelled: true }));
    xhr.send(blob);
  });
  return { promise, abort: () => xhr.abort() };
}

// data:image/png;base64,… -> Blob, without fetch() (the page CSP only allows connections to itself).
export function dataUriToBlob(uri) {
  const match = /^data:([^;,]+)?((?:;[^;,]+)*?)(;base64)?,(.*)$/s.exec(uri);
  if (!match) return null;
  const type = match[1] || 'application/octet-stream';
  if (match[3]) {
    const binary = atob(match[4]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  }
  return new Blob([decodeURIComponent(match[4])], { type });
}

export function imageExtension(type) {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp' }[type] || 'png';
}
