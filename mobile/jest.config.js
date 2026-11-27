module.exports = {
  preset: '@react-native/jest-preset',
  // The first run in a fresh copy reads all of React Native before a test can start, which alone takes longer than
  // jest's five seconds: the first test of every file timed out there, and passed on each later run.
  testTimeout: 30000,
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|marked|entities)/)',
  ],
};
