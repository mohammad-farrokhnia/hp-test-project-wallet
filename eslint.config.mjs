// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
      'no-restricted-globals': ['error', { name: 'parseFloat', message: 'No floats for money (ADR-4)' }],
      'no-restricted-properties': ['error',
        { object: 'Number', property: 'parseFloat', message: 'No floats for money (ADR-4)' },
        { property: 'toFixed', message: 'No floats for money (ADR-4)' }],
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.name='Number']", message: 'No floats for money (ADR-4)' }],
    },
  },
);
