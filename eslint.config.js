// Lint rules carried over from the SplitSats house style (no-console, no-debugger,
// prettier-as-an-error, unused-imports), minus the Angular-specific layers.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import unusedImports from 'eslint-plugin-unused-imports';

export default tseslint.config(
  {
    ignores: ['dist/**', 'data/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  prettierRecommended,
  {
    // Type-aware linting applies to TypeScript sources only; the flat config
    // file itself is plain JS and is not in any tsconfig program.
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.check.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'unused-imports': unusedImports,
    },
    rules: {
      // Secrets discipline (global rule 6): nothing reaches stdout by accident.
      'no-console': 'error',
      'no-debugger': 'error',
      'prettier/prettier': 'error',

      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'unused-imports/no-unused-imports': 'error',

      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Operator entrypoints and scripts are the one place stdout is the product.
    files: ['src/operator/**/*.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  }
);
