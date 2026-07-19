# Tenant operation lock

Every installed tenant has one lock for stateful operations. The lock is the blob
`locks/tenant-operation.json` in the runtime's private `state` container. The SPA, GitHub Actions,
local live testing, and future tenant jobs must all enter operations through
`runWithTenantLock`; callers must not create another coordination path.

This contract is implemented and tested offline. Issue #26 owns the first deployment and live lock
proof after explicit human authorization.

## Operation sequence

[`runtime/tenant-lock.mjs`](../runtime/tenant-lock.mjs) provides the shared sequence:

```text
validate the operation identity
→ acquire the fixed tenant blob lease
→ run the operation
→ renew the lease before it expires when work is still active
→ release the lease in success and failure paths
```

The default lease lasts 30 seconds. Azure Blob Storage permits finite leases from 15 through 60
seconds. The shared runner automatically renews halfway through each lease window for as long as the
operation callback remains active. If renewal fails, the runner aborts the callback, waits for it to
stop, and returns the lock failure; callbacks must observe the supplied `AbortSignal` and may call
`assertLockHeld` immediately before a state change. If a process crashes, Azure expires the lease
without requiring a second recovery service, and a later operation can acquire the same blob.

The lease ID is an ownership secret. It remains inside the lock session and is sent only to Blob
Storage for protected writes, renewal, and release. It is never written into the blob record or
returned as status evidence.

## Ownership and contention evidence

The leased blob contains a small versioned record with only:

- tenant ID;
- operation ID and kind;
- caller class (`spa`, `github-actions`, `local-spa`, or `tenant-job`);
- exact source commit; and
- acquisition, renewal, and expiration timestamps.

It contains no access token, lease ID, user identity, request headers, or raw Azure error. A blocked
caller receives the sanitized current owner when it validates, plus a bounded retry interval. If
the stored record is malformed, the caller still fails closed as busy but does not repeat arbitrary
stored content.

Only the session holding the lease can renew, update, or release the record. A caller that attempts
to use an expired or replaced session receives `lock_lost` and must not continue changing tenant
state.

## Blob access

[`runtime/blob-lease-store.mjs`](../runtime/blob-lease-store.mjs) uses the Azure Blob REST operations
directly. It accepts a managed-identity access-token function, creates the fixed block blob if it is
absent, and uses Blob lease acquire, renew, and release operations for exclusivity. The existing
`Storage Blob Data Contributor` assignment on the private state container supplies the required
data-plane access. Shared keys and SAS credentials are not used.

The runtime Bicep contract publishes the fixed path through
`AFTER_PARTY_TENANT_LOCK_BLOB` and returns the same path in deployment verification. A runtime with
a missing or different lock path cannot report an exact verified deployment.

## Diagnostic and offline proof

`runTenantLockDiagnostic` is an operation definition over `runWithTenantLock`, not a separate lock
implementation. When another operation owns the lock, the diagnostic is blocked through the same
contention path. When it succeeds, its evidence proves that it exclusively acquired and released
the shared lock. For a repeatable contention check it may hold the lease for up to 10 seconds while
a second diagnostic attempts the same path; the bound remains shorter than the minimum Azure lease
duration and the diagnostic does not change tenant state.

Offline tests cover simultaneous acquisition, sanitized contention, automatic renewal beyond the
original lease window, abort on renewal loss, release after success and failure, expiration after a
simulated crash, stale-owner rejection, and the complete Blob REST request path. They exercise the
same lock controller, storage adapter, and diagnostic that the deployed API will call.

## Microsoft references

- [Lease Blob](https://learn.microsoft.com/en-us/rest/api/storageservices/lease-blob)
- [Authorize Azure Storage requests with Microsoft Entra ID](https://learn.microsoft.com/en-us/rest/api/storageservices/authorize-with-azure-active-directory)
- [Put Blob](https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob)
