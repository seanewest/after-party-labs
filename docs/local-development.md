# Local development

Pull requests are tested locally. Only `main` is deployed to the public GitHub Pages site.

## Run the site

Install Node.js, then run these commands from the repository root:

```bash
npm ci
npm run dev
```

Open <http://127.0.0.1:4173/> in a browser. Using that exact loopback address matters because it
matches the registered local Microsoft sign-in redirect. Stop the server with `Ctrl+C`.

The command builds `site/` into `dist/` with the current Git commit and a local `/` base path, copies
the pinned MSAL Browser dependency, then serves the generated files using Node's built-in HTTP
server. It requires no external development server.

When the worktree contains modified or untracked files, the generated version identity is `<commit>-dirty`. This intentionally cannot match the full commit SHA of a deployed API. Commit or stash local changes and rebuild before attempting a live-capable test that requires exact version alignment.

The site is built once when the command starts. After changing files in `site/`, stop and rerun the command to see the new build.

The equivalent direct Node command is:

```bash
node scripts/serve-pages.mjs
```

To choose another port:

```bash
PORT=8080 npm run dev
```

## Run tests

```bash
npm test
```

The tests run offline and cover Microsoft sign-in and installation, tenant-runtime planning and
verification, Pages build metadata, and the local static server. CI also compiles the Bicep runtime
with the pinned Bicep CLI version.

For the dedicated certificate operator, controlled browser flow, tenant-wide development lease,
and deployed acceptance command, see [Agent-operated SPA acceptance](agent-operated-spa.md).
