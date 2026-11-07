// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Config/tooling files aren't part of the TS program; use non-type-checked rules.
  {
    files: ['*.js', '*.config.js', '*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  // Integration tests live under tests/, outside the tsconfig's `src` program, so
  // the type-aware parser can't resolve them. Lint them without type info.
  {
    files: ['tests/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  // Tests reference mocked methods as values (expect(jira.createStory)...) and
  // inspect dynamically-typed mock payloads (parsed JSON, fetch call args), so the
  // unbound-method and unsafe-any family are false positives here. Production code
  // stays fully strict; these relaxations apply only to test files.
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  // Prettier last: turn off any formatting rules that would conflict.
  prettier,
);
