# Blog Theme

A blog theme for Methanol.

## Features

- Post list and post pages
- Category/collection views (theme-provided client UI)
- Responsive layout

## Usage

CLI:

```bash
methanol build --theme blog
methanol dev --theme blog
```

Config (`methanol.config.*`):

```js
export default () => ({
	theme: 'blog'
})
```

## Structure

- `src/page.jsx`: main layout template
- `pages/`: theme pages (including special pages like `_404.mdx` and `offline.mdx` when present)
- `components/`: theme components used by MDX
- `public/`: theme static assets
- `sources/`: theme source mappings (used by `theme.sources`)

## Local development

If you want to use the theme from a local folder (instead of built-in name / npm package), import it in config:

```js
import createBlogTheme from './themes/blog/index.js'

export default () => ({
	theme: createBlogTheme()
})
```
