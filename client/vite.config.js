import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, '');

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: `http://${env.HOST || '127.0.0.1'}:${env.PORT || 5000}`,
          changeOrigin: true,
        },
      },
    },
  };
});
