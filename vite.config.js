import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  plugins: [vue()],
  optimizeDeps: {
    include: ['quill'],
  },
  server: {
    port: 3000, // Ensure the port is set correctly
  },
  build: {
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
    },
  },
});