/** @type {import('jest').Config} */
const base = {
  rootDir: ".",
  moduleFileExtensions: ["ts", "tsx", "js", "json"],
  transform: { "^.+\.(t|j)sx?$": ["ts-jest", {}] },
  testEnvironment: "node",
  // edge/ is its own pnpm package (own deps, tested with vitest); keep jest out of its node_modules.
  modulePathIgnorePatterns: ["<rootDir>/edge/.*/node_modules"],
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/edge/"],
};

const containers = {
  globalSetup: "<rootDir>/test/setup/global-setup.ts",
  globalTeardown: "<rootDir>/test/setup/global-teardown.ts",
};

module.exports = {
  testTimeout: 120000,
  projects: [
    { ...base, displayName: "unit", testMatch: ["<rootDir>/src/**/*.spec.ts"] },
    { ...base, displayName: "integration", testMatch: ["<rootDir>/src/**/*.int-spec.ts"], ...containers },
    { ...base, displayName: "e2e", testMatch: ["<rootDir>/test/e2e/**/*.e2e-spec.ts"], ...containers },
  ],
};
