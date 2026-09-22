import * as path from 'path';

import { defineConfig } from 'vitest/config';

// Standalone test config so the runner does not load `vite.config.ts` (the
// webview bundler config, which pulls in React-only plugins). Extension unit
// tests are plain Node — no DOM, no bundling.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // `vscode` only exists inside the extension host. The stub is the minimum
      // that lets a test import a module for its pure functions; see
      // test/stubs/vscode.ts.
      vscode: path.join(__dirname, 'test', 'stubs', 'vscode.ts'),
    },
  },
});
