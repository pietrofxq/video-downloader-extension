import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'extension/vendor/**'],
  },
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'warn',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'warn',
    },
  },
  // .ts files use typescript-eslint's parser so the JS rules above don't
  // misread TS syntax. The same conventions (no-console, eqeqeq,
  // prefer-const) apply; `no-unused-vars` is the TS-aware variant.
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ['extension/**/*.ts'],
    languageOptions: {
      ...(c.languageOptions ?? {}),
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...(c.languageOptions?.globals ?? {}),
        ...globals.browser,
        ...globals.webextensions,
        chrome: 'readonly',
      },
    },
    rules: {
      ...(c.rules ?? {}),
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'warn',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'warn',
    },
  })),
  {
    files: ['build.mjs', '*.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },
];
