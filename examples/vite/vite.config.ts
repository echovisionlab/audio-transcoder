import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const codecAssets = fileURLToPath(
  new URL('../../.artifacts/codec-assets-package/', import.meta.url),
);

export default defineConfig({
  publicDir: codecAssets,
  root,
  build: {
    emptyOutDir: true,
    manifest: true,
    outDir: 'dist',
  },
  preview: {
    host: '127.0.0.1',
    port: 8080,
    strictPort: true,
  },
  server: {
    host: '127.0.0.1',
    port: 8080,
    strictPort: true,
  },
  worker: {
    format: 'es',
  },
});
