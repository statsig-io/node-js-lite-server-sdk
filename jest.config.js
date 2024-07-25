module.exports = {
  roots: ['./'],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/jest.setup.js'],
  testMatch: ['**/__tests__/**/*test.(j|t)s', '**/?(*.)+test.(j|t)s'],
  testPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/src/__tests__/jest.setup.js',
    '<rootDir>/dist/',
  ],
  testEnvironment: 'node',
  snapshotFormat: {
    escapeString: true,
    printBasicPrototype: true,
  },
  moduleNameMapper: {
    // Force module uuid to resolve with the CJS entry point, because Jest does not support package.json.exports. See https://github.com/uuidjs/uuid/issues/451
    uuid: require.resolve('uuid'),
  },
};
