/* CI gate for react-hooks/rules-of-hooks ONLY.

   The full `npm run lint` still reports ~140 pre-existing errors (mostly
   no-unused-vars) and cannot fail the build until those are cleaned up.
   But rules-of-hooks is at zero and must stay there: a hook called after
   an early return changes the hook count between two renders of the same
   component, React throws "Rendered more hooks than during the previous
   render", and since the app has no route boundaries the whole tree
   unmounts to a blank page.

   `eslint --rule` ADDS a rule rather than restricting to it, which is why
   this needs its own config rather than a flag on the main one. */
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2020,
      globals: { ...globals.browser, __APP_VERSION__: 'readonly' },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
    },
  },
])
