import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.spec.ts',
      'packages/*/src/**/__tests__/*.test.ts',
      'packages/*/src/**/__tests__/*.spec.ts',
    ],
    setupFiles: ['./tests/test-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        'packages/*/src/**/*.d.ts',
        'packages/*/src/**/__tests__/**',
      ],
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 80,
        statements: 80,
      },
      reporter: ['text', 'text-summary', 'lcov', 'html'],
      reportsDirectory: './coverage',
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
