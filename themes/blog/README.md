# Blog Theme

A simple, clean blog theme for Methanol.

## Features
- Clean typography
- Post list on homepage
- Responsive design
- Dark mode support (via system preference)

## Usage

To use this theme, configure your Methanol project to point to this directory.

```js
// methanol.config.js
export default {
  theme: './themes/blog',
  // ...
}
```

## Structure
- `src/page.jsx`: Main layout template.
- `sources/style.css`: Stylesheet.
- `pages/`: Default pages (Home, 404, Offline).
