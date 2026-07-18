# AFTER PARTY LABS

After Party is an exploratory testbed for a future Microsoft 365 and Azure cybersecurity lab platform.

The `main` branch is configured to publish at <https://seanewest.github.io/after-party-labs/>. Pull requests are tested locally and are not deployed publicly.

## Documentation

- [Run the site and tests locally](docs/local-development.md)
- [Follow the broader development workflow](docs/development.md)
- [Create, verify, or delete the multitenant application](docs/multitenant-application.md)

## Local Pages build

```bash
npm run build:pages
```

The generated site is written to `dist/`.
