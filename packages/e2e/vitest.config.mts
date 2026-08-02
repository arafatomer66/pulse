import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    // The whole suite shares one table, one queue set and one MailHog.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 90_000,
  },
  // Nest DI needs design:paramtypes metadata, which neither esbuild nor Vite's
  // Oxc transform emits. swc does, so the built-in transform is turned off.
  oxc: false,
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
