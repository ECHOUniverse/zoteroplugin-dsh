import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    // Node's test runner is not involved; vitest owns the whole loop.
    globals: false,
  },
})
