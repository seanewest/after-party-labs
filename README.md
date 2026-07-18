# AFTER PARTY LABS

[![CI](https://github.com/seanewest/after-party-labs/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/seanewest/after-party-labs/actions/workflows/ci.yml)

After Party is an exploratory testbed for a future Microsoft 365 and Azure cybersecurity lab platform.

[Check out the published site.](https://seanewest.github.io/after-party-labs/) The `main` branch publishes the site through GitHub Pages. Pull requests are tested locally and are not deployed publicly.

## Documentation

- [Run the site and tests locally](docs/local-development.md)
- [Follow the broader development workflow](docs/development.md)
- [Create, verify, or delete the multitenant application](docs/multitenant-application.md)

## Local Pages build

```bash
npm run build:pages
```

The generated site is written to `dist/`.
