# Dispatcher queue core

This directory contains the local, durable handoff queue from Task #35. It deliberately does not
attach to Codex sessions or poll GitHub; Tasks #36 and #37 implement those adapters against this
core.

## Delivery contract

Delivery is **at least once**. Each envelope keeps one stable message ID across attempts. A runner
claims a lease, marks delivery as started, and the recipient records a durable receipt keyed by the
message ID. Once that receipt exists, a restarted queue will not claim the message again.

There is an unavoidable crash window after an external recipient accepts a prompt but before the
receipt becomes durable. The queue retries the same message ID after the lease expires; it does not
claim exactly-once prompt delivery.

The normal state sequence is:

    queued -> leased -> delivering -> receipted -> acknowledged -> completed

Delivery errors move an in-flight message to `failed`; an explicit retry returns it to `queued`.
Expired `leased` or `delivering` messages return to `queued` automatically. Only `queued` and
`failed` messages can be cancelled before a receipt arrives.

## Extension points

- A session runner calls `claimNext`, `beginDelivery`, `recordReceipt`, and `acknowledge`.
- A GitHub event source calls `enqueue` with a durable `dedupeKey` derived from the source event.
- Both adapters may create separate `DispatcherQueue` instances against the same SQLite file;
  `BEGIN IMMEDIATE` transactions and conditional state changes serialize competing consumers.

The default database is `${XDG_STATE_HOME:-~/.local/state}/after-party/dispatcher.sqlite`. Set
`PARTY_DISPATCHER_DB` or pass `--database` to use an isolated location.

Run `npm run party -- help` for the compact CLI, `npm run check:types` for static checks, and
`npm run test:dispatcher` for the offline queue suite.
