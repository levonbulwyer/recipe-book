# Recipe Book

A personal recipe book. Recipes are shown as Cooking for Engineers step tables, built automatically from each recipe's steps. Metric only.

- Runs on GitHub Pages: the data is a SQLite file (`recipes.db`) read and saved in the browser with sql.js.
- Runs on a Mac with `python3 server.py` (or the `Start Recipe Book.command` launcher one folder up): saves to `../Data/recipes.db` with daily backups in `../Backups/`.

Files: `index.html`, `app.js`, `styles.css` (the app), `sql-wasm.js` and `sql-wasm.wasm` (sql.js 1.10.3), `server.py` (local server, Python standard library only), `recipes.db` (starting data), `tools/` (schema and the script that rebuilds the starting data).
