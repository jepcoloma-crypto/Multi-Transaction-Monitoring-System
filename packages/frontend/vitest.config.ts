import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Kept separate from vite.config.ts so the dev server's proxy and the test
// runner's settings cannot drift into each other.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    // Testing Library registers its auto-cleanup through the global
    // `afterEach`; without globals each render would leak into the next test.
    globals: true,
  },
});
