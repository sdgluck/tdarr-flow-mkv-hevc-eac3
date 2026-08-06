// Commands are returned from functions so lint-staged does not append staged
// filenames to them.
//
// The findings suite is deliberately NOT run here - it is red by design until
// each defect is fixed, so gating commits on it would block every commit.
export default {
  'flows/**/*.json': () => ['pnpm lint:flow', 'pnpm test'],
  'plugins/**/*.js': () => 'pnpm test',
  '{tests,scripts}/**/*.ts': () => ['pnpm typecheck', 'pnpm test'],
};
