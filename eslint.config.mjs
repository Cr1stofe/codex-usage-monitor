import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'artifacts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['test/**/*.cjs'], rules: { '@typescript-eslint/no-require-imports': 'off' }, languageOptions: { globals: { require: 'readonly', process: 'readonly', Buffer: 'readonly', setTimeout: 'readonly' } } },
);
