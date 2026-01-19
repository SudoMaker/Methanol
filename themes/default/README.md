# Default Theme

The default Methanol theme is designed for documentation sites (sidebar navigation + table of contents).

## Enable

CLI:

```bash
methanol build --theme default
methanol dev --theme default
```

Config:

```js
export default () => ({
	theme: 'default'
})
```

## Notes

- User `public/` assets override theme-provided `public/` assets.
- Theme pages under `pages/` can provide special routes like `_404.mdx` and `offline.mdx`.

