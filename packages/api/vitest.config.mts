import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    exclude: ['test/**/*.e2e.spec.ts'],
    environment: 'node',
    // Specs boot the real AppModule against the shared local DynamoDB table.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  // Vitest's default transform drops decorator metadata, which Nest's DI needs
  // at runtime. swc emits it, so the built-in transform is turned off.
  oxc: false,
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
