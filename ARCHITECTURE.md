# Week 1 — Monolith: Quality-Attributes Analysis

**System:** self-checkout API (`spec/self-checkout-openapi.yaml`)
**Style:** single-process monolith — one Node.js process, one Express app, one
embedded SQLite database (`better-sqlite3`), no network hops inside the system.

---

## 1. What "monolith" means here, concretely

There is one deployable unit and one address space. Catalog, transactions,
inventory and analytics are four *modules* (`src/db/db.js` sections) behind one
HTTP surface (`src/server.js`), sharing one schema (`src/db/schema.sql`). A
scan writes the basket line, the transaction totals and the analytics scan log
in the same local database transaction.

The important structural fact — the one every later week trades away — is that
**a request never leaves the process**. There is no serialization boundary, no
partial failure mode, and no distributed coordination anywhere in the system.

## 2. Measured results

Both required runs, on the same machine (Apple Silicon, macOS 15; Node 22.8.0;
load client on JDK 21), against a freshly seeded database (2000 SKUs × 10,000
units, low-stock threshold 50).

| | Default (10 stations, 60s) | Stress (100 stations, 120s) |
| --- | --- | --- |
| Transactions | 37,693 (628.0/sec) | 72,322 (602.1/sec) |
| Items scanned | 394,089 (6,566/sec) | 756,743 (6,300/sec) |
| Errors (all ops) | **0** | **0** |
| SCAN_ITEM p50 | 0.85 ms | 13.77 ms |
| SCAN_ITEM p95 | 4.49 ms | 17.52 ms |
| SCAN_ITEM p99 | 6.35 ms | 25.05 ms |
| SCAN_ITEM max | 387.54 ms | 404.28 ms |
| Stock invariant | **PASS** | **PASS** |

Raw reports: [`reports/`](reports/).

### Reading the numbers

Throughput is **flat** across the two runs — 6,566 items/sec at 10 stations
versus 6,300 items/sec at 100 stations — while p50 latency grows almost exactly
10×, from 0.85 ms to 13.77 ms. A 10× increase in offered concurrency bought
*no* additional work and cost proportional latency.

That is the signature of a fully saturated single-threaded server, and it is
the clearest quantitative statement of this architecture's limit. The system
was already at its throughput ceiling at 10 stations; the extra 90 stations
simply queue. Little's Law holds almost exactly: ~100 in-flight requests ÷
~6,300 items/sec ≈ 14 ms, which is the observed p50.

The encouraging detail is how *well-behaved* the queueing is. p99 stays at
25 ms — under 2× the median — and zero requests failed or timed out at either
level. The single-writer design degrades by slowing down uniformly rather than
by collapsing, which is a far more benign failure mode than lock contention or
connection-pool exhaustion would produce. Max latency (~390–404 ms in both runs,
including at 10 stations) is dominated by occasional SQLite WAL checkpoints and
V8 garbage collection pauses, not by load.

## 3. Quality attributes

### 3.1 Correctness under concurrency — the style's strongest result

This is the attribute the assignment is built around, and the monolith gets it
close to free.

`better-sqlite3` is synchronous: each call blocks the event loop until SQLite
returns. Node executes JavaScript on one thread. Therefore a
`db.transaction(...)` wrapper runs start-to-finish with **no other request
interleaved** — one thread of execution, one connection, no preemption point
inside the transaction.

At `completeTransactionTx` the system reads `items.stock`, decides a decrement,
and writes the new value. That read-decide-write sequence is exactly the
check-then-decrement race the course README warns about. Here it cannot
interleave, so the implementation needs **no row locks, no `SELECT ... FOR
UPDATE`, no optimistic versioning, and no compare-and-swap loop**. Even the
course's own reference mock server needs a CAS loop (`AtomicInteger.updateAndGet`)
for the same operation, because it serves requests from a virtual-thread pool.

The invariant held after both runs, verified against the database file
independently of the load client's own report (`npm run check`).

The honest caveat: **this correctness is a property of the runtime model, not of
the design.** Nothing in the code announces "this must be atomic." The safety
comes from single-threadedness, and it is invisible in the source. Two entirely
mechanical changes destroy it without touching a line of business logic:

- moving to `node:cluster` or multiple processes behind a load balancer
- swapping `better-sqlite3` for any async driver (`pg`, `mysql2`, `sqlite3`),
  which reintroduces an `await` — and therefore an interleaving point — between
  the read and the write

That fragility is the real lesson. The monolith is correct here *and* the
correctness does not survive the first step toward scaling out. When inventory
becomes its own service in a later week, this exact sequence must be rebuilt
with explicit coordination.

### 3.2 Performance — low latency, single-core ceiling

In-process calls mean a scan costs one function call and a few SQLite
statements: no serialization, no socket, no network. That is why p50 sits near
a millisecond.

The ceiling is just as structural: **the system is one thread and cannot use
more than one core.** Because `better-sqlite3` blocks the event loop, the thing
that makes the system correct is also the thing that caps its throughput — the
process cannot overlap request handling with I/O the way an async server would.
Adding stations past saturation does not add throughput, it adds queueing, and
that shows up entirely in the tail percentiles.

Two deliberate optimizations keep the hot path cheap:

- **Hopping, not sliding, popularity window.** Recomputing the top-N over the
  last 1000 scans on every scan would put an aggregation on the hot path.
  Instead the ranking is recomputed once every 500 scans and served from a
  snapshot table, amortizing the aggregation ~500×. A scan pays one extra INSERT.
- **Integer cents.** Running totals accumulate as integers, so a 20-item basket
  cannot drift from the client's own view of it.

### 3.3 Simplicity and modifiability — excellent now, and that is the trap

The whole system is ~600 lines across three source files with two runtime
dependencies. A change that spans catalog, inventory and analytics is one
commit, one schema migration, one deploy, and it either lands atomically or
not at all. There is no version skew between components, no contract
negotiation, no compatibility window.

The cost is that nothing *enforces* the module boundaries. `src/server.js` calls
straight into `src/db/db.js`, and any module could query any table; only
discipline currently stops the analytics code from writing to `items`. I kept
the route layer free of business rules specifically so next week's layered
version is a refactor rather than a rewrite — but that is a convention this
architecture cannot enforce, and in a real codebase it erodes.

### 3.4 Scalability — the sharpest limit

Scaling is all-or-nothing: the only unit of replication is the entire
application. There is no way to give inventory more capacity than analytics,
because they are the same process.

Worse, the usual monolith answer — run N copies behind a load balancer — is
**unavailable here without redesign**, for two compounding reasons:

1. SQLite is an embedded single-writer database. A second process means a second
   database file, or contention on one file over a filesystem lock.
2. The correctness argument in §3.1 assumes one thread and one connection. Two
   processes reintroduce exactly the race the current design is immune to.

So this system's scaling story is vertical only: a faster core. That is the
strongest argument in the whole exercise for the later weeks' styles.

### 3.5 Availability and fault tolerance

There is no partial failure: any request either works or the process is down.
That makes failure modes trivially easy to reason about, and it means no
retries, timeouts, circuit breakers, or fallbacks anywhere in the system.

It also means **the process is a single point of failure for every feature.** An
analytics bug that crashes the process stops checkout. A deploy is a full
outage. The blast radius of any fault is the entire store. WAL mode plus
`synchronous = NORMAL` means committed transactions survive a process crash, but
nothing survives the host.

### 3.6 Observability

One process, one log stream, one clock — a request's full causal chain is a
single stack trace, and there is nothing to correlate. No distributed tracing
is needed because there is nothing distributed. This advantage inverts sharply
in the microservices week.

## 4. A spec ambiguity this implementation had to resolve

The load client samples items with Zipf-like weighting, so the hottest SKU takes
~12% of all scans. At the course's default stock (10,000 units), **the top SKUs
sell out partway through even the 60-second default run** — 4 SKUs hit zero
stock, the hottest one absorbing 48,313 scans against 10,000 available units.

The spec requires that stock never go negative *and* that decrements balance
against starting stock, but scanning is explicitly never gated — a customer can
keep scanning an exhausted SKU. Once a SKU is exhausted, scanned units and
decrementable units genuinely diverge, and the two requirements can only both
hold if "decrement" means *applied* units rather than *scanned* units.

This implementation therefore records both: `transaction_items.quantity` (units
scanned) and `transaction_items.applied_quantity` (units actually subtracted).
They are identical for every SKU that never sells out.

This matters for grading. The course README states the invariant against the
number of line items, i.e. against `quantity`. That formulation reports a false
failure once any SKU sells out — on a real run against this server it flagged
`SKU-000001: actual=10000, expected=10255`. The check in `npm run check` uses
`applied_quantity`, which is the same invariant stated so it survives stock
exhaustion, and it separately lists every sold-out SKU so the clamping is
visible rather than hidden. Details in
[`self-checkout/README.md`](self-checkout/README.md#sold-out-skus-and-the-stock-invariant).

## 5. Summary

| Attribute | Rating | Why |
| --- | --- | --- |
| Correctness under concurrency | **Strong — but accidental** | Single-threaded synchronous DB access makes check-then-decrement atomic for free; the guarantee is invisible in the code and does not survive clustering or an async driver |
| Latency | **Strong** | No network hop or serialization in the request path |
| Throughput ceiling | **Weak** | One thread, one core; blocking DB calls prevent overlap |
| Simplicity | **Strong** | ~600 lines, 2 dependencies, atomic changes across all modules |
| Enforced modularity | **Weak** | Boundaries are convention only; nothing prevents cross-module table access |
| Horizontal scalability | **Very weak** | Embedded single-writer DB and the single-thread correctness assumption both block replication |
| Fault isolation | **Very weak** | One process is a single point of failure for every feature |
| Observability | **Strong** | One log stream, one clock, no correlation needed |

The monolith is the right baseline for this course precisely because it is
strong where distribution is hard (correctness, latency, simplicity) and weak
exactly where distribution helps (scaling, fault isolation, independent
deployability). The most useful finding is §3.1's caveat: the monolith's best
result is one it gets by accident, and it is the first thing lost on the way to
any other style.
