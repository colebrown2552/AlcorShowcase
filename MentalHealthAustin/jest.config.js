// Jest configuration: jsdom environment, babel/ts transforms and static-asset mocks.
module.exports = {
    preset: 'ts-jest',
    testEnvironment: "jsdom",
    transform: {
      '^.+\\.(ts|tsx)?$': 'ts-jest',
      // Inline presets because .babelrc does not apply to files inside node_modules (react-leaflet is ESM).
      '^.+\\.(js|jsx)$': ['babel-jest', { presets: ['@babel/preset-env', '@babel/preset-react'] }],
    },
    moduleNameMapper: {
        "\\.(css|less|scss)$": "<rootDir>/__mocks__/styleMock.js",
        "\\.(svg)$": "<rootDir>/__mocks__/svgMock.js",
        "\\.(webp|png|jpe?g|PNG)$": "<rootDir>/__mocks__/webpMock.js",
    },
    // react-leaflet ships as ES modules, so let babel-jest transform it
    // (the pattern avoids path separators so it also works on Windows).
    transformIgnorePatterns: ['node_modules.(?!(react-leaflet|@react-leaflet))'],
    setupFilesAfterEnv: ['<rootDir>/src/App.test.js']
  };