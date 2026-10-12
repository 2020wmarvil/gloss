import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Destructuring a prop to leave it out of a rest spread is intentional.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }]
    }
  },
  {
    files: ['src/main/**/*.ts'],
    rules: {
      // The main build is CommonJS; require.resolve locates the adapter script.
      '@typescript-eslint/no-require-imports': 'off'
    }
  }
)
