import js from '@eslint/js';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'simple-import-sort': simpleImportSort,
      'unicorn': eslintPluginUnicorn,
    },
    rules: {
      ...tsPlugin.configs['recommended-type-checked'].rules,

      // TypeScript handles undefined references; no-undef causes false positives
      // for TypeScript global types like NodeJS.Timeout
      'no-undef': 'off',

      'curly': 'warn',
      'eqeqeq': 'warn',
      'no-dupe-keys': 'error',

      '@typescript-eslint/no-explicit-any': 'error',

      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports',
        fixStyle: 'separate-type-imports',
      }],

      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      '@typescript-eslint/no-unused-expressions': ['error', {
        allowShortCircuit: true,
      }],

      '@typescript-eslint/naming-convention': ['warn', {
        selector: 'import',
        format: ['camelCase', 'PascalCase'],
      }],

      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',

      'unicorn/filename-case': ['error', { case: 'kebabCase' }],

      'max-lines': ['warn', { max: 2000, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  eslintConfigPrettier,
];
