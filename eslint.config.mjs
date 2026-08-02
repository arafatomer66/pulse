import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'infra/cdk.out/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      // Domain types carry optional fields that are legitimately absent; the
      // strict-boolean flavour of these rules fights the codebase more than it
      // helps it.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Adapters and handlers deal in `unknown` from JSON.parse and provider
      // SDKs; narrowing is done explicitly where it matters.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Workers and scripts log to stdout deliberately — that is their transport
    // to CloudWatch.
    files: ['packages/workers/**/*.ts', 'packages/api/scripts/**/*.ts', 'infra/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
