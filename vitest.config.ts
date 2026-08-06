import { defineConfig } from 'vitest/config';

// The regression suite: everything here passes today and must keep passing.
// If a fix for a finding turns one of these red, the fix broke something.
export default defineConfig({
  test: { include: ['tests/regression/**/*.test.ts'], environment: 'node' },
});
