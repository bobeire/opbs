import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Runner contention on CI pushed ordinary tests past the 5s default twice
    // (preflight-health once, an e2e hook once) — false reds. Real hangs are
    // still caught by these bounds.
    testTimeout: 15_000,
    hookTimeout: 30_000,
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['test/**', 'dist/**']
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
});
