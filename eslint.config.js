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
  // Prettier last: turn off any formatting rules that would conflict.
  prettier,
);
