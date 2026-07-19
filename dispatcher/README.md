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

## Worker and escalation boundary

The same database holds one durable availability record for each named worker. The core recognizes
`unknown`, `idle`, `busy`, `asleep`, and `unavailable`; it ignores stale observations and will not
lease queued work to a worker currently marked `unavailable`. Task #36 owns observing real Codex
sessions and updating these records.

Escalations are durable, deduplicated records for worker unavailability, ambiguous ownership,
repeated review cycles, delivery failures, or a manual intervention. They remain assigned
conceptually to Morpheus without silently changing a Task's `Agent`. Task #37 may create them when
GitHub routing cannot safely choose a recipient, while Task #36 may create them when a worker is
genuinely unavailable.

## Extension points

- A session runner calls `claimNext`, `beginDelivery`, `recordReceipt`, and `acknowledge`.
- A session runner calls `setWorkerAvailability` with its independently observed lifecycle state.
- A GitHub event source calls `enqueue` with a durable `dedupeKey` derived from the source event.
- Either adapter calls `createEscalation`; Morpheus inspects and resolves the durable record.
- Both adapters may create separate `DispatcherQueue` instances against the same SQLite file;
  `BEGIN IMMEDIATE` transactions and conditional state changes serialize competing consumers.

The default database is `${XDG_STATE_HOME:-~/.local/state}/after-party/dispatcher.sqlite`. Set
`PARTY_DISPATCHER_DB` or pass `--database` to use an isolated location.

Run `npm run party -- help` for the compact CLI, `npm run check:types` for static checks, and
`npm run test:dispatcher` for the offline queue suite.
