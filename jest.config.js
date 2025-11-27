/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts', '**/*.spec.ts'],
  collectCoverageFrom: [
    'livetemplate-client.ts',
    'dom/**/*.ts',
    'state/**/*.ts',
    'transport/**/*.ts',
    'upload/**/*.ts',
    'utils/**/*.ts',
    '!**/index.ts',
    '!**/types.ts',
    '!tests/**',
    '!dist/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  verbose: true
};