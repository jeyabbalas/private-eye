import { defineConfig } from 'vitest/config';

// Standalone test config (kept out of the app's tsconfig `include`, so the
// production `tsc --noEmit` typecheck stays focused on shipping code). The suites
// exercise the numeric-critical pure functions — the safety core of the
// no-fabrication guarantee — in a plain Node environment. Vite's resolver handles
// the project's explicit `.ts` import specifiers, so sources import unchanged.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
