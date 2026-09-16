# Clipboard App (Clippy)

Clippy is a lightweight, self-hosted shared clipboard with rich-text and image support, backed by SQLite.

## Current UI

- Bright, consistent teal/coral color system with high-contrast controls, visible focus rings, responsive reflow, and reduced-motion support.
- Full-height desktop workspace with saved entries on the left and the rich-text composer on the right.
- Horizontally collapsible composer (expanded by default) for a maximum-width saved-entry view.
- Lightweight native rich editor with formatting, links, pasted/uploaded images, and no vulnerable Quill dependency.
- Responsive mobile layout, locally bundled Bootstrap Icons, subtle motion, skip navigation, live status announcements, and accessible icon-only copy/delete actions.
- Rich clipboard copy writes both `text/html` and `text/plain`, preserving embedded images and formatting in compatible browsers.
- The application version is shown in the top-right corner and sourced from `package.json`.

## Security and accessibility

- Runtime dependencies are pinned through `package-lock.json`; `npm audit` is expected to report zero known vulnerabilities.
- Express emits Content Security Policy, clickjacking, MIME-sniffing, and referrer-protection headers.
- Storage is bounded by configurable per-image, per-entry, and total-database byte limits; oversized writes return HTTP `413`.
- The first durable startup copies the legacy `/database.sqlite` database when present, preserving upgrades from older images.
- Playwright runs Accessibility Insights-equivalent automated checks using the same axe-core WCAG A/AA tags, plus tab-order, keyboard-trap, responsive reflow, and functional checks.
- GitHub Actions runs contract, functional, keyboard, responsive, and accessibility tests before publishing an image.

## Development

```bash
npm ci
npm test
npm run build
```

Run Playwright against a deployed instance:

```bash
BASE_URL=http://clippy.internal npm run test:e2e
```

## Docker deployment

Build from source:

```bash
docker build -t clippy:latest .
```

Before replacing an older container that stored SQLite at `/database.sqlite`, copy that file into the durable bind root while the old container still exists:

```bash
docker cp clippy:/database.sqlite /home/sudip/data/apps/clippy/data/database.sqlite
```

Verify the copied database before removing the old container (for example, compare checksums and run `PRAGMA integrity_check`). The application-side `LEGACY_DATABASE_PATH` fallback handles legacy files only when they are visible inside the new container; it cannot read a removed container layer.

Deploy on the Homelabs DNS server (ARM64) with the required runtime contract:

```bash
docker run -d \
  --name clippy \
  --hostname clippy \
  --network app_network \
  --user root \
  --restart unless-stopped \
  -e DATABASE_PATH=/data/database.sqlite \
  -e LEGACY_DATABASE_PATH=/database.sqlite \
  -e MAX_IMAGE_BYTES=5242880 \
  -e MAX_ENTRY_BYTES=10485760 \
  -e MAX_DATABASE_BYTES=262144000 \
  -v /home/sudip/data/apps/clippy/data:/data \
  -p 3001:3000 \
  clippy:latest
```

Open the configured internal hostname (`http://clippy.internal`) or `http://<dns-server-address>:3001`. SQLite data is persisted at `/home/sudip/data/apps/clippy/data/database.sqlite` through the `/data` bind mount.

## License

Licensed under the GNU GPLv3 License.
