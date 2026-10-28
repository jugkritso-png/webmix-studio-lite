import { defineConfig } from 'vite';

// base './' so the build works under any GitHub Pages sub-path
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
});
