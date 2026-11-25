# Website to Word

Chrome extension for saving the current webpage and selected cited pages as Word, Markdown or PDF.

## Build on your machine

Use Node.js 24. Run `npm ci --ignore-scripts`, then `npm run build`. Open `chrome://extensions`, turn on Developer mode and load `build/extension`. The build copies the pinned browser dependencies and their notices from the installed packages. The source repository carries no generated bundles.

## Browser access

The extension reads the active page when you start an export. It requests linked pages and images as part of the chosen export. Chrome may use the active session to fetch them. Exports are written locally; use the extension only for pages you are authorized to save.

Run the focused packaging check with `node --test tests/package.test.mjs`.

[Current status](docs/HANDOFF.md)
