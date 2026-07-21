# Agent-operated SPA acceptance

The development acceptance path uses the same public SPA, Microsoft authorization-code and PKCE
flow, tenant consent, Azure deployment controls, and runtime API as an ordinary operator. It adds no
authentication bypass and injects no token or browser storage. A fresh Playwright context presents
one tenant-bound user certificate only to Microsoft's certificate-authentication origin and then
drives the visible pages and SPA controls.

This is development infrastructure for the isolated `corywest.onmicrosoft.com` tenant. It is not a
student authentication mechanism and must not be copied to another tenant, subscription, or region
without a new decision.

## Credential boundary

`npm run operator -- prepare` creates a dedicated **After Party Development Operator** certificate
authority, encrypted private keys, an encrypted PFX, and separate random passphrase files under
`~/.config/after-party/spa-operator/`. The directory and files are owner-only and outside Git. The
command performs no tenant or Azure operation.

The live provisioning command uses the separately configured **After Party Development Admin**
certificate identity to reconcile exactly one cloud user, one exclusive CBA group and trust, active
Global Administrator, and Owner on subscription
`6d8ebd0e-017f-401e-950d-e5a35de93dc6`. The user's random bootstrap password is discarded during
creation and is never written or printed. Browser operation uses only the encrypted PFX. Provision,
revoke, browser authentication, deployment, and proof all acquire the external development-tenant
lease first; loss of lease renewal aborts the browser context.

```bash
npm run operator -- prepare
npm run operator -- provision
npm run operator -- status
```

Provisioning fails closed on another tenant, subscription, region, UPN, group, CBA trust, role
scope, certificate mapping, or untracked matching object. It records the pre-change authentication
policy and owned object IDs in the external operator directory. To revoke browser access, remove
both broad roles, restore the prior policy, remove the owned CBA trust and group, clear the
certificate mapping, and disable the user:

```bash
npm run operator -- revoke
```

Revocation leaves the disabled user object as an audit record. Rotating the operator creates a new
external certificate set and must keep the same exact custody and tenant boundary.

## Browser modes

Authentication-only mode proves a fresh CBA sign-in, the SPA's real MSAL redirect/session behavior,
the dedicated account and tenant, and permission verification without an Azure mutation:

```bash
npm run spa:acceptance -- --mode authenticate
```

The complete deployed proof requires the exact `main` artifacts currently returned by the public
`version.json`:

```bash
npm run spa:acceptance -- \
  --mode prove \
  --commit FULL_40_CHARACTER_MAIN_COMMIT \
  --runtime-image ghcr.io/seanewest/after-party-labs/runtime@sha256:FULL_DIGEST
```

The driver selects only the authorized subscription and `eastus`, verifies the displayed tenant,
role, resource list, commit, and image before checking the confirmation control, then runs install
or repair and the tenant-lock diagnostic. It repeats both operations to prove safe reconciliation
and reuse.

Sanitized JSON and masked screenshots are written under ignored `.artifacts/goal-20/`. Diagnostics
contain bounded visible text, path-only URLs, control state, and failed network method/path/status.
They never include request headers or bodies, HAR, video, cookies, authorization codes, access or
refresh tokens, browser storage, passphrases, or private-key content. A timeout, Conditional Access
block, password prompt, certificate failure, redirect loop, wrong account, wrong tenant, wrong
artifact identity, or lost lock fails visibly and preserves the sanitized diagnostic before the
fresh browser context closes.
