import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '.claude/**',
      '**/*.d.ts',
      // SvelteKit UI has its own toolchain under ui/; don't lint it with
      // the backend's ESLint config.
      'ui/**',
      // Local/private marketing drafts are intentionally gitignored and
      // can depend on operator-only assets; they are outside the OSS
      // backend lint target.
      'marketing/**',
      // Deploy artifacts (Dockerfile, Helm chart, pm2 manifest) are not
      // part of the TypeScript backend lint target — same posture as
      // ui/ above. The pm2 ecosystem config is CommonJS + node globals,
      // which the backend's TS-project ESLint config does not cover.
      'deploy/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'no-throw-literal': 'error',
    },
  },
  {
    files: ['test/**/*.ts', '**/*.test.ts', 'scripts/**/*.ts', 'src/scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  prettierConfig,
];
