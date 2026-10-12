import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/main/**/*.ts'],
    rules: {
      // The main build is CommonJS; require.resolve locates the adapter script.
      '@typescript-eslint/no-require-imports': 'off'
    }
  }
)
