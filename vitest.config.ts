import { defineConfig } from 'vitest/config';

// Two projects, selected by name. The default run is unit-only: no network,
// no Docker (global rule 7). The integration project is opt-in and expects a
// local relay and a local Nutshell mint.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
