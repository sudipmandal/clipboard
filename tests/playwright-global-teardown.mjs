import { rmSync } from 'node:fs';

export default function teardown() {
  const root = process.env.CLIPPY_E2E_ROOT;
  if (root) rmSync(root, { recursive: true, force: true });
}