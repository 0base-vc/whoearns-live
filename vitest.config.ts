import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'coverage'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'threads',
    // vitest 4 moved pool-specific options to the top level;
    // `singleThread: false` is the default so no explicit option is needed.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/entrypoints/**',
        'src/index.ts',
        'src/types/**',
        'src/**/*.types.ts',
        'src/clients/types.ts',
        'src/core/logger.ts',
        'src/scripts/**',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
