# Local development

Pull requests are tested locally. Only `main` is deployed to the public GitHub Pages site.

## Run the site

Install Node.js, then run this command from the repository root:

```bash
npm run dev
```

Open <http://127.0.0.1:4173/> in a browser. Stop the server with `Ctrl+C`.

The command builds `site/` into `dist/` with the current Git commit and a local `/` base path, then serves the generated files using Node's built-in HTTP server. It requires no package installation or external development server.

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

The tests run offline and cover the Pages build metadata and local static server.
