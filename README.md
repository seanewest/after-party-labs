# After Party Labs

[![CI](https://github.com/seanewest/after-party-labs/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/seanewest/after-party-labs/actions/workflows/ci.yml)

After Party is a future cybersecurity lab platform for Microsoft 365 and Azure. It is being built to let learners connect an isolated tenant, create realistic organizational activity and misconfigurations, and investigate what happened using Microsoft security tools.

The project is under active development. [Visit the current website.](https://seanewest.github.io/after-party-labs/)

## Run it locally

With Node.js installed, run these commands from the repository root:

```bash
npm ci
npm run dev
```

Open <http://127.0.0.1:4173/>. Run the test suite with `npm test`.

See [Local development](docs/local-development.md) for ports, build behavior, and other details.

## Documentation

- [Product direction](docs/product.md)
- [Architecture](docs/architecture.md)
- [Local development](docs/local-development.md)
- [Development and collaboration workflow](docs/development.md)
- [Adopted decisions](docs/decision.md)
- [Create, verify, or delete the multitenant application](docs/multitenant-application.md)
- [Tenant runtime bootstrap](docs/tenant-runtime.md)
- [Tenant operation lock](docs/tenant-lock.md)
- [Agent-operated SPA acceptance](docs/agent-operated-spa.md)
