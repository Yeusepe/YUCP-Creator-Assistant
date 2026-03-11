import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  publicDir: false,
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'public/assets/collab-invite'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'frontend/collab-invite.tsx'),
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'collab-invite.js',
        chunkFileNames: 'collab-invite.js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.names.some((name) => name.endsWith('.css'))) {
            return 'collab-invite.css';
          }
          return 'assets/[name][extname]';
        },
      },
    },
  },
});
