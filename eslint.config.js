import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Apply typescript-eslint recommended config
  ...tseslint.configs.recommended,
  // Apply TS configuration to TypeScript files
  {
    files: ['**/*.ts'],
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', '**/*.js.map', '**/*.d.ts'],
    rules: {
      'no-console': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // Add configuration for JavaScript files
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', '**/*.js.map', '**/*.d.ts'],
  }
);
