import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'demo' ? './' : '/',
  define: { __TASKWEAVE_DEMO__: mode === 'demo' },
  build: { sourcemap: false, target: 'es2022', outDir: mode === 'demo' ? 'dist-demo' : 'dist' },
}));
