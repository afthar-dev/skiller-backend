/** @type {import('jest').Config} */
const base = {
  rootDir: ".",
  moduleFileExtensions: ["ts", "tsx", "js", "json"],
  transform: { "^.+\.(t|j)sx?$": ["ts-jest", {}] },
  testEnvironment: "node",
};

module.exports = {
  testTimeout: 120000,
  projects: [
    { ...base, displayName: "unit", testMatch: ["<rootDir>/src/**/*.spec.ts", "<rootDir>/edge/**/*.spec.ts"] },
    { ...base, displayName: "integration", testMatch: ["<rootDir>/src/**/*.int-spec.ts"] },
    { ...base, displayName: "e2e", testMatch: ["<rootDir>/test/e2e/**/*.e2e-spec.ts"] },
  ],
};
