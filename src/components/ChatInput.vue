<template>
  <div class="chat-input">
    <div
      ref="dropZone"
      class="composer-editor"
      :class="{ 'is-dragging': dragging }"
      @dragenter="onDragOver"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <div class="editor-toolbar" role="toolbar" aria-label="Text formatting">
        <button v-for="tool in tools" :key="tool.command" class="tool-button" type="button" :disabled="sending" :aria-label="tool.label" :title="tool.label" @click="applyFormat(tool)">
          <i :class="tool.icon" aria-hidden="true"></i>
        </button>
        <span class="toolbar-divider" aria-hidden="true"></span>
        <button class="tool-button" type="button" :disabled="sending" aria-label="Insert link" title="Insert link" @click="insertLink">
          <i class="bi bi-link-45deg" aria-hidden="true"></i>
        </button>
        <button class="tool-button" type="button" :disabled="sending" aria-label="Insert image" title="Insert image" @click="openImagePicker">
          <i class="bi bi-image" aria-hidden="true"></i>
        </button>
        <button class="tool-button" type="button" :disabled="sending" aria-label="Attach files" title="Attach files" @click="$refs.fileInput.click()">
          <i class="bi bi-paperclip" aria-hidden="true"></i>
        </button>
        <button class="tool-button" type="button" :disabled="sending" aria-label="Clear formatting" title="Clear formatting" @click="applyFormat({ command: 'removeFormat' })">
          <i class="bi bi-eraser" aria-hidden="true"></i>
        </button>
        <input ref="imageInput" class="visually-hidden" type="file" accept="image/*" :disabled="sending" tabindex="-1" aria-hidden="true" @change="insertImage">
        <input ref="fileInput" class="visually-hidden" type="file" multiple :disabled="sending" tabindex="-1" aria-hidden="true" @change="onFilesPicked">
      </div>
      <div
        ref="editor"
        class="rich-editor"
        :contenteditable="!sending"
        role="textbox"
        aria-label="Rich text editor"
        aria-multiline="true"
        data-placeholder="Paste or type anything…"
        @input="syncContent"
        @keyup="saveSelection"
        @mouseup="saveSelection"
        @paste="handlePaste"
        @keydown.enter.ctrl.exact.prevent="sendMessage"
        @keydown.enter.meta.exact.prevent="sendMessage"
      ></div>
      <div v-if="dragging" class="drop-overlay" aria-hidden="true">
        <i class="bi bi-cloud-arrow-up" aria-hidden="true"></i>
        <strong>Drop files to attach</strong>
        <span v-if="limits">up to {{ formatBytes(limits.maxFileBytes) }} each</span>
      </div>
    </div>
    <ul v-if="attachments.length" class="composer-files" aria-label="Files to send">
      <li v-for="item in attachments" :key="item.key" class="composer-file" :class="`is-${item.status}`">
        <i :class="['bi', fileIcon(item.type, item.name)]" aria-hidden="true"></i>
        <span class="composer-file-name" :title="item.name">{{ item.name }}</span>
        <span class="composer-file-meta">{{ item.status === 'error' ? item.error : formatBytes(item.size) }}</span>
        <span v-if="item.status === 'uploading'" class="composer-file-progress" role="progressbar" :aria-valuenow="Math.round(item.progress * 100)" aria-valuemin="0" aria-valuemax="100" :aria-label="`Uploading ${item.name}`">
          <span :style="{ width: `${Math.round(item.progress * 100)}%` }"></span>
        </span>
        <button class="composer-file-remove" type="button" :disabled="sending" :aria-label="`Remove ${item.name}`" @click="removeAttachment(item)">
          <i class="bi bi-x-lg" aria-hidden="true"></i>
        </button>
      </li>
    </ul>
    <p v-if="limits" class="file-limits">
      <i class="bi bi-paperclip" aria-hidden="true"></i>
      Files up to <strong>{{ formatBytes(limits.maxFileBytes) }}</strong> each, {{ limits.maxFilesPerEntry }} per entry<template v-if="storageFree !== null"> · <strong>{{ formatBytes(storageFree) }}</strong> of {{ formatBytes(limits.maxFilesBytes) }} storage free</template>
    </p>
    <p v-if="errorMessage" class="composer-error" role="alert"><i class="bi bi-exclamation-triangle" aria-hidden="true"></i> {{ errorMessage }}</p>
    <div class="composer-actions">
      <span class="composer-hint"><i class="bi bi-image" aria-hidden="true"></i> Text, images &amp; files · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to send</span>
      <span class="visually-hidden" role="status" aria-live="polite">{{ statusMessage }}</span>
      <button class="send-button" type="button" aria-keyshortcuts="Control+Enter Meta+Enter" title="Send entry (Ctrl+Enter)" :disabled="!canSend" @click="sendMessage">
        <i :class="sending || uploading ? 'bi bi-arrow-repeat spin' : 'bi bi-send-fill'" aria-hidden="true"></i>
        {{ uploading ? 'Uploading…' : sending ? 'Saving…' : 'Send entry' }}
      </button>
    </div>
  </div>
</template>

<script>
import DOMPurify from 'dompurify';
import { looksLikeCliOutput } from '../cliDetect.mjs';
import { formatBytes, fileIcon, uploadFile, dataUriToBlob, imageExtension, isInlineImage } from '../files.mjs';

let attachmentKey = 0;

export default {
  props: {
    // { maxFileBytes, maxFilesBytes, filesBytesUsed, maxFilesPerEntry } from api/config
    limits: { type: Object, default: null },
  },
  emits: ['sendMessage'],
  data() {
    return {
      message: '',
      sending: false,
      statusMessage: '',
      errorMessage: '',
      dragging: false,
      attachments: [],
      savedRange: null,
      pendingCleanupClaims: [],
      tools: [
        { command: 'bold', label: 'Bold', icon: 'bi bi-type-bold' },
        { command: 'italic', label: 'Italic', icon: 'bi bi-type-italic' },
        { command: 'underline', label: 'Underline', icon: 'bi bi-type-underline' },
        { command: 'insertUnorderedList', label: 'Bulleted list', icon: 'bi bi-list-ul' },
        { command: 'insertOrderedList', label: 'Numbered list', icon: 'bi bi-list-ol' },
      ],
    };
  },
  computed: {
    hasContent() {
      const text = this.message.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').trim();
      return Boolean(text || /<img\b/i.test(this.message));
    },
    uploading() {
      return this.attachments.some((item) => item.status === 'uploading');
    },
    readyAttachments() {
      return this.attachments.filter((item) => item.status === 'done');
    },
    hasAttachmentErrors() {
      return this.attachments.some((item) => item.status === 'error');
    },
    canSend() {
      return !this.sending && !this.uploading && !this.hasAttachmentErrors && (this.hasContent || this.readyAttachments.length > 0);
    },
    storageFree() {
      if (!this.limits || typeof this.limits.filesBytesUsed !== 'number') return null;
      return Math.max(0, this.limits.maxFilesBytes - this.limits.filesBytesUsed);
    },
  },
  created() {
    this.inlineBlobs = new Map(); // blob: URL of a pasted image -> File, uploaded when the entry is sent
  },
  beforeUnmount() {
    this.attachments.forEach((item) => item.handle?.abort());
    this.inlineBlobs.forEach((file, url) => URL.revokeObjectURL(url));
  },
  methods: {
    formatBytes,
    fileIcon,
    hasFiles(event) {
      return Array.from(event.dataTransfer?.types || []).includes('Files');
    },
    onDragOver(event) {
      if (!this.hasFiles(event)) return; // keep normal text drag-and-drop inside the editor
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      this.dragging = true;
    },
    onDragLeave(event) {
      if (!this.$refs.dropZone.contains(event.relatedTarget)) this.dragging = false;
    },
    onDrop(event) {
      this.dragging = false;
      if (this.sending || !this.hasFiles(event)) return;
      event.preventDefault();
      this.addFiles(event.dataTransfer.files);
    },
    onFilesPicked(event) {
      this.addFiles(event.target.files);
      event.target.value = '';
    },
    addFiles(fileList) {
      if (this.sending) return;
      this.errorMessage = '';
      const maxFile = this.limits?.maxFileBytes ?? Infinity;
      const maxCount = this.limits?.maxFilesPerEntry ?? Infinity;
      for (const file of Array.from(fileList || [])) {
        const item = { key: (attachmentKey += 1), name: file.name, size: file.size, type: file.type, status: 'uploading', progress: 0, error: '', id: null, token: null, handle: null };
        this.attachments.push(item);
        const live = this.attachments[this.attachments.length - 1]; // reactive proxy
        if (this.attachments.filter((entry) => entry.status !== 'error').length > maxCount) {
          Object.assign(live, { status: 'error', error: `Max ${maxCount} files per entry` });
        } else if (file.size > maxFile) {
          Object.assign(live, { status: 'error', error: `Larger than ${formatBytes(maxFile)}` });
        } else {
          this.startUpload(live, file);
        }
      }
    },
    startUpload(item, file) {
      item.handle = uploadFile(file, file.name, (progress) => { item.progress = progress; });
      item.handle.promise
        .then((stored) => Object.assign(item, { status: 'done', id: stored.id, token: stored.token, type: stored.type, progress: 1 }))
        .catch((error) => {
          if (error.cancelled) return;
          Object.assign(item, { status: 'error', error: error.message });
        })
        .finally(() => { item.handle = null; });
      this.statusMessage = `Uploading ${file.name}`;
    },
    removeAttachment(item) {
      item.handle?.abort();
      if (item.status === 'done' && item.id) {
        fetch(`api/files/${item.id}`, { method: 'DELETE', headers: { 'X-Upload-Token': item.token } }).catch(() => {});
      }
      this.attachments = this.attachments.filter((entry) => entry.key !== item.key);
    },
    // Pasted/inserted images are shown from a blob: URL while composing, then uploaded as files on send.
    insertImageFile(file, label) {
      if (!isInlineImage(file.type)) {
        this.addFiles([file]); // e.g. SVG: never shown inline, attached as a file instead
        return;
      }
      const maxFile = this.limits?.maxFileBytes ?? Infinity;
      if (file.size > maxFile) {
        this.errorMessage = `Image is larger than ${formatBytes(maxFile)}`;
        return;
      }
      const url = URL.createObjectURL(file);
      this.inlineBlobs.set(url, file);
      this.$refs.editor.focus();
      this.restoreSelection();
      document.execCommand('insertImage', false, url);
      this.syncContent();
      this.statusMessage = label;
    },
    // Uploads every blob:/data: image of the editor HTML and points it to its stored file.
    // Returns the rewritten HTML and the [{ id, token }] claims the server needs to link the images.
    async uploadInlineImages(html, uploadedClaims = []) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const claims = [];
      for (const image of doc.querySelectorAll('img')) {
        const src = image.getAttribute('src') || '';
        let blob = null;
        if (src.startsWith('blob:')) blob = this.inlineBlobs.get(src) || null;
        else if (/^data:image\//i.test(src)) blob = dataUriToBlob(src);
        else continue;
        if (!blob || !isInlineImage(blob.type)) { image.remove(); continue; }
        const name = blob.name || `pasted-image.${imageExtension(blob.type)}`;
        const stored = await uploadFile(blob, name).promise;
        image.setAttribute('src', stored.url);
        const claim = { id: stored.id, token: stored.token };
        claims.push(claim);
        uploadedClaims.push(claim);
      }
      return { html: doc.body.innerHTML, claims };
    },
    syncContent() {
      this.message = this.$refs.editor.innerHTML;
      this.saveSelection();
    },
    saveSelection() {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (this.$refs.editor.contains(range.commonAncestorContainer)) {
        this.savedRange = range.cloneRange();
      }
    },
    restoreSelection() {
      if (!this.savedRange) return;
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(this.savedRange);
    },
    applyFormat(tool) {
      this.$refs.editor.focus();
      this.restoreSelection();
      document.execCommand(tool.command, false, null);
      this.syncContent();
    },
    insertLink() {
      const url = window.prompt('Enter a secure link (https://)');
      if (!url || !/^https:\/\//i.test(url)) return;
      this.$refs.editor.focus();
      this.restoreSelection();
      document.execCommand('createLink', false, url);
      this.syncContent();
    },
    openImagePicker() {
      this.saveSelection();
      this.$refs.imageInput.click();
    },
    insertImage(event) {
      const [file] = event.target.files || [];
      if (file && file.type.startsWith('image/')) this.insertImageFile(file, 'Image inserted');
      event.target.value = '';
    },
    handlePaste(event) {
      const image = Array.from(event.clipboardData?.items || []).find((item) => item.type.startsWith('image/'));
      if (!image) return;
      event.preventDefault();
      const file = image.getAsFile();
      if (!file) return;
      this.saveSelection();
      this.insertImageFile(file, 'Image pasted');
    },
    async sendMessage() {
      if (!this.canSend) return;
      this.sending = true;
      this.errorMessage = '';
      this.statusMessage = 'Saving entry';
      let inlineClaims = [];
      try {
        await this.cleanupClaims(this.pendingCleanupClaims);
        const { html, claims } = this.hasContent ? await this.uploadInlineImages(this.message, inlineClaims) : { html: '', claims: [] };
        inlineClaims = claims;
        const response = await fetch('api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: DOMPurify.sanitize(html),
            mono: !/<img\b/i.test(html) && looksLikeCliOutput(this.$refs.editor.innerText),
            attachments: this.readyAttachments.map((item) => ({ id: item.id, token: item.token })),
            inlineUploads: claims,
          }),
        });
        if (!response.ok) {
          let reason = '';
          try { reason = (await response.json()).error; } catch { /* not JSON */ }
          throw new Error(reason || `Save failed (${response.status})`);
        }
        const data = await response.json();
        this.$emit('sendMessage', data);
        this.message = '';
        this.$refs.editor.innerHTML = '';
        this.attachments = [];
        this.inlineBlobs.forEach((file, url) => URL.revokeObjectURL(url));
        this.inlineBlobs.clear();
        this.statusMessage = 'Entry saved';
      } catch (error) {
        await this.cleanupClaims(inlineClaims);
        console.error('Unable to save entry:', error);
        this.errorMessage = `Not saved: ${error.message}`;
        this.statusMessage = 'Unable to save entry';
      } finally {
        this.sending = false;
      }
    },
    async cleanupClaims(claims) {
      if (!claims.length) return;
      const failed = [];
      await Promise.all(claims.map(async ({ id, token }) => {
        try {
          const response = await fetch(`api/files/${id}`, { method: 'DELETE', headers: { 'X-Upload-Token': token } });
          if (!response.ok && response.status !== 404) failed.push({ id, token });
        } catch {
          failed.push({ id, token });
        }
      }));
      this.pendingCleanupClaims = failed;
    },
  },
};
</script>

<style>
.chat-input { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 16px; gap: 14px; }
.visually-hidden { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
.composer-editor { flex: 1; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 16px; overflow: hidden; background: var(--surface); box-shadow: inset 0 1px 0 var(--editor-highlight); }
.editor-toolbar { flex: 0 0 auto; display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 9px; border-bottom: 1px solid var(--border); background: var(--surface-soft); }
.tool-button { display: grid; place-items: center; width: 36px; height: 36px; padding: 0; border: 0; border-radius: 9px; color: var(--muted); background: transparent; cursor: pointer; transition: color .18s ease, background .18s ease, transform .18s ease; }
.tool-button:hover { color: var(--primary-dark); background: var(--primary-soft); transform: translateY(-1px); }
.toolbar-divider { width: 1px; height: 24px; margin: 0 4px; background: var(--border); }
.rich-editor { flex: 1; min-height: 160px; overflow-y: auto; padding: 18px; color: var(--text); font-size: 15px; line-height: 1.65; outline: none; }
.rich-editor:empty::before { content: attr(data-placeholder); color: var(--placeholder); pointer-events: none; }
.rich-editor:focus { box-shadow: inset 0 0 0 3px var(--focus-soft); }
.rich-editor img { display: block; max-width: 100%; height: auto; margin: 10px 0; border-radius: 12px; }
.composer-editor { position: relative; }
.composer-editor.is-dragging { border-color: var(--primary); box-shadow: 0 0 0 3px var(--focus-soft); }
.drop-overlay { position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; border-radius: 16px; color: var(--primary-dark); background: color-mix(in srgb, var(--surface) 88%, transparent); font-size: 13px; pointer-events: none; }
.drop-overlay .bi { font-size: 32px; color: var(--primary); }
.composer-files { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.composer-file { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 8px; padding: 7px 8px 7px 11px; overflow: hidden; border: 1px solid var(--border); border-radius: 11px; background: var(--surface-soft); font-size: 13px; }
.composer-file > .bi { color: var(--primary); font-size: 16px; }
.composer-file.is-error { border-color: var(--danger); }
.composer-file.is-error > .bi, .composer-file.is-error .composer-file-meta { color: var(--danger); }
.composer-file-name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
.composer-file-meta { color: var(--muted); font-size: 12px; white-space: nowrap; }
.composer-file-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: var(--primary-soft); }
.composer-file-progress span { display: block; height: 100%; background: var(--primary); transition: width .2s ease; }
.composer-file-remove { display: grid; place-items: center; width: 26px; height: 26px; border: 0; border-radius: 7px; color: var(--muted); background: transparent; cursor: pointer; }
.composer-file-remove:hover { color: #fff; background: var(--danger); }
.file-limits { margin: -4px 0 0; color: var(--muted); font-size: 12px; }
.file-limits .bi { margin-right: 4px; color: var(--secondary); }
.composer-error { margin: -4px 0 0; color: var(--danger); font-size: 13px; font-weight: 600; }
.composer-actions { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.composer-hint { color: var(--muted); font-size: 12px; }
.composer-hint i { margin-right: 6px; color: var(--secondary); }
.composer-hint kbd { padding: 1px 5px; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 5px; background: var(--surface-soft); color: var(--text); font: 600 11px/1.4 ui-monospace, monospace; }
.send-button { display: inline-flex; align-items: center; justify-content: center; gap: 9px; min-width: 136px; min-height: 44px; padding: 0 18px; border: 0; border-radius: 12px; color: #fff; background: linear-gradient(135deg, var(--primary), var(--secondary)); font-size: 14px; font-weight: 700; box-shadow: 0 10px 24px var(--shadow-primary); cursor: pointer; transition: transform .18s ease, box-shadow .18s ease, filter .18s ease; }
.send-button:hover:not(:disabled) { color: #fff; filter: saturate(1.1) brightness(.97); transform: translateY(-2px); box-shadow: 0 14px 28px var(--shadow-primary-hover); }
.send-button:disabled { color: var(--btn-disabled-text); background: var(--btn-disabled-bg); box-shadow: none; cursor: not-allowed; }
.spin { animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 480px) { .composer-hint { display: none; } .send-button { width: 100%; } }
</style>
