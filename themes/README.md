# Themes

Methanol ships with built-in themes under `themes/`.

## Built-in themes

- `default`: Documentation-style theme (sidebar + ToC).
- `blog`: Blog theme (post list, tags/categories UI).

## Using a theme

CLI:

```bash
methanol build --theme blog
methanol dev --theme default
```

Config (`methanol.config.*`):

```js
export default () => ({
	theme: 'blog'
})
```

## Using a local theme (in your project)

Theme name resolution only applies when `theme` is a string (built-in or `methanol-theme-xxx` from `node_modules`).
If your theme lives inside your project, import it and pass the theme object/factory:

```js
import createTheme from './themes/my-theme/index.js'

export default () => ({
	theme: createTheme()
})
```

## Publishing a theme

If you publish a theme as an npm package named `methanol-theme-xxx`, users can enable it via `--theme xxx` or `theme: 'xxx'`.

## Theme structure (convention)

- `index.js`: entrypoint that exports a theme object or a factory function (recommended).
- `src/`: theme runtime/template modules (e.g. `src/page.jsx`).
- `components/`: theme components (used by MDX).
- `pages/`: theme-provided pages (e.g. `_404.mdx`, `offline.mdx`).
- `public/`: theme static assets (merged with user `public/`).
- `sources/`: extra source mappings exposed via `theme.sources`.

