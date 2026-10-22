import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    // The exec-loop and git-sync tests spawn git and runners; alone they take
    // ~1s, but under a full parallel run they pass 5s and time out.
    testTimeout: 30_000,
  },
});
