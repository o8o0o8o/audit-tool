import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    ignores: ['dist/', 'node_modules/', 'audit-results/', 'coverage/'],
  },
  {
    rules: {
      // Relax rules for existing codebase
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'warn',
      'no-console': 'off',
      'no-useless-escape': 'off', // Too many false positives in regex-heavy SEO analysis code
      'no-control-regex': 'off', // Intentional control char matching in content analysis
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
