// StrykerJS skeleton only. Not wired to CI until the API package adds Stryker dependencies.
export default {
  coverageAnalysis: 'off',
  mutate: ['src/**/*.ts', '!src/**/*.test.ts', '!src/**/*.d.ts'],
  reporters: ['clear-text', 'progress'],
  testRunner: 'command',
  commandRunner: {
    command: 'bun run test:ci',
  },
};
