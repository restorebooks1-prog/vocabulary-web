# Repository Guidelines

## Project Structure & Module Organization

Buildless GitHub Pages vocabulary library using JavaScript ES modules.

- `index.html` and `style.css`: page structure and responsive styling.
- `app.js`: DOM rendering, filters, checkbox interactions, and synchronization orchestration.
- `core.js`: data validation, filtering, and progress merging; keep these functions independent of the DOM.
- `cloud.js`, `config.js`, and `firestore.rules`: Firebase integration, public client configuration, and database authorization.
- `data/catalog.json`: collection and item navigation; `data/<dataset-id>.json`: vocabulary datasets.
- `tests/*.test.mjs`: automated tests; `scripts/`: preview server and dataset validator.
- `skills/japanese-subtitle-vocab-json/`: Japanese subtitle JSON generation instructions and format reference.

## Build, Test, and Development Commands

- `npm start`: serve locally at `http://127.0.0.1:8765`; use HTTP rather than opening HTML directly.
- `npm test`: run Node's built-in test runner.
- `npm run validate`: validate catalog references, datasets, and subtitle time groups.
- `node --check app.js`: check JavaScript syntax without execution.

No build step or formatter/linter is configured. Preserve `.nojekyll` for GitHub Pages.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, descriptive camelCase identifiers, and ES module imports. Match nearby code without unrelated reformatting. Use the `readable-performant-code` skill for code creation, changes, fixes, and refactoring.

Render JSON-defined columns in their declared order. Use `textContent` for dataset text; never interpret it as HTML or executable code. Keep dataset and word IDs stable: lowercase letters, digits, underscores, and hyphens, starting with an alphanumeric character, maximum 80 characters. Dataset schema is version 2; catalog and progress schemas remain version 1.

## Testing Guidelines

Use `node:test` and `node:assert/strict`, with descriptive behavior-based test names. Add focused tests for changed validation, filtering, or merge behavior. No numeric coverage threshold is configured. Run tests and dataset validation before submitting changes. For UI changes, check desktop/mobile interaction and keyboard access; report untested browser or Firebase behavior explicitly.

## Commit & Pull Request Guidelines

History contains only `init`; no commit convention exists. Use concise imperative subjects. PRs should explain the behavior change, validation performed, and configuration requirements; include screenshots for visible changes and link relevant issues when available.

## Security & Data Boundaries

Built-in vocabulary is published through Git; website JSON imports publish public vocabulary to Firebase and must be restricted to the configured Google owner UID by Firestore rules. Vocabulary export is public and excludes personal progress. Personal checkbox and filter states belong in localStorage and Firebase, never published datasets. Frontend checks alone do not authorize database access. Never commit service-account keys or tokens. Keep data management controls, status and persistence explanations below the table, in the footer under its divider.
