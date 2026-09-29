import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxy = {
  '/api': {
    target: 'http://127.0.0.1:8000',
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    port: 5173,
    strictPort: true,
    proxy: apiProxy,
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'three',
              test: /node_modules[\\/]three/,
              priority: 50,
            },
            {
              name: 'recharts',
              test: /node_modules[\\/]recharts/,
              priority: 30,
            },
            {
              name: 'leaflet',
              test: /node_modules[\\/]leaflet/,
              priority: 35,
            },
            {
              name: 'chart-utils',
              test: /node_modules[\\/](victory-vendor|d3-)/,
              priority: 40,
            },
            {
              name: 'vendor',
              test: /node_modules/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
