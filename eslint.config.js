import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      'no-console': ['error', { allow: ['info', 'error'] }],
    },
  },
];
