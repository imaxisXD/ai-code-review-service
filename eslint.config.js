import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  // Apply typescript-eslint recommended config
  ...tseslint.configs.recommended,
  // Add import plugin configuration
  {
    plugins: {
      import: importPlugin,
    },
  },
  // Apply TS configuration to TypeScript files
  {
    files: ['**/*.ts'],
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', '**/*.js.map', '**/*.d.ts'],
    rules: {
      'no-console': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      // Enforce .js extension for imports in ES modules
      'import/extensions': [
        'error',
        'always',
        {
          ignorePackages: true,
          pattern: {
            js: 'always',
            ts: 'never',
            tsx: 'never',
            jsx: 'never',
          },
        },
      ],
    },
  },
  // Add configuration for JavaScript files
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', '**/*.js.map', '**/*.d.ts'],
  }
);
