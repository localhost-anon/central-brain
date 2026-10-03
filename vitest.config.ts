import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .claude/worktrees holds other branches' checkouts; their tests are not this tree's.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
