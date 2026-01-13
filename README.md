# Methanol

Opinionated MDX-first static site generator powered by rEFui + Vite.

For full documentation and examples, visit [Methanol Docs](https://methanol.netlify.app/).

## Quick start

```bash
# build
npx methanol build

# dev server
npx methanol dev

# preview the production build
npx methanol serve
```

From this repo, use `node bin/methanol.js [dev|build|serve]`.

## Project layout

Methanol expects a project like this:

```
pages/        # .mdx pages (file-based routing)
components/   # JSX/TSX components used by MDX
public/       # static assets copied/served as-is
dist/         # build output
```

## Configuration

Create `methanol.config.{js,mjs,cjs,ts,jsx,tsx,mts,cts}` and export a function:

```js
export default () => ({
	// optional: search (Pagefind)
	pagefind: {
		enabled: true
	},

	// optional: code highlighting (Starry Night, default: enabled)
	starryNight: false,

	// optional: worker thread count (0 = auto)
	jobs: 0,

	// optional: pwa support
	pwa: true,

	// optional: site metadata
	site: {
		base: '/docs/'
	},

	// optional: theme sources
	theme: {
		sources: {
			'/.my-theme': './sources'
		}
	}
})
```

## CLI notes

- `methanol preview` is an alias for `methanol serve`
