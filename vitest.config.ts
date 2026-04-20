import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Build dist/ ONCE before any test file runs. Closes a CI race where two
    // test files' beforeAll hooks both spawned `npm run build`, and file A's
    // `clean-dist && tsc` wiped dist/ while file B was reading it. See
    // tests/global-setup.ts for the full explanation.
    globalSetup: ['tests/global-setup.ts'],
  },
});
