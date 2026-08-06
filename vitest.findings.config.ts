import { defineConfig } from 'vitest/config';

// The findings suite asserts CORRECT behaviour, so it is RED while the defects
// it describes are unfixed. Each test goes green when, and only when, its
// defect is actually fixed. See tests/README.md.
export default defineConfig({
  test: { include: ['tests/findings/**/*.test.ts'], environment: 'node' },
});
