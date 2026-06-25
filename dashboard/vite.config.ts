import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
  },
  resolve: {
    alias: {
      react: resolve('./node_modules/react'),
      'react-dom': resolve('./node_modules/react-dom'),
    },
  },
});
