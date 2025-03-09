import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

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
      input: 'public/index.html',
    },
  },
});