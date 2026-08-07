import { defineConfig } from 'vitest/config';

// The findings suite asserts CORRECT behaviour, so it is RED while the defects
// it describes are unfixed, and a test goes green when its defect is fixed.
//
// It is currently EMPTY: every finding raised in the review has been fixed and
// its assertions moved into tests/regression, which is where they belong once
// they pass. Add a new tests/findings/*.test.ts when the next defect turns up.
export default defineConfig({
  test: {
    include: ['tests/findings/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
