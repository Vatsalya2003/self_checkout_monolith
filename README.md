# CS6510 — Self-Checkout System, Week 1: Monolith

Implementation of the shared self-checkout API contract
([`spec/self-checkout-openapi.yaml`](https://github.com/gortonator/CS6510-2026/blob/main/spec/self-checkout-openapi.yaml))
as a single-process **monolith**, plus the load-test evidence for it.

## Contents

| Path                  | What it is                                                          |
| --------------------- | ------------------------------------------------------------------- |
| `self-checkout/`      | The server: Node.js + Express + better-sqlite3, one process         |
| `ARCHITECTURE.md`     | Quality-attributes analysis of the monolith style                   |
| `reports/`            | Load-client JSON reports for the required default and stress runs   |

See [`self-checkout/README.md`](self-checkout/README.md) for how to build, run,
and verify the server.

## Reproducing the results

```bash
# 1. The server (wipes and reseeds its database on every start)
cd self-checkout && npm install && npm start

# 2. The course load client, from a clone of gortonator/CS6510-2026
cd CS6510-2026/load-client && ./build.sh
./run.sh --baseUrl=http://localhost:8080 --stations=10  --duration=60    # default
./run.sh --baseUrl=http://localhost:8080 --stations=100 --duration=120   # stress

# 3. After each run, before restarting the server
cd self-checkout && npm run check
```

Restart the server between the two runs so each starts from full stock.

## Results summary

Both required runs completed with **zero errors** across all three operations,
and the stock invariant held after both. Full numbers, and what they say about
the architecture, are in [`ARCHITECTURE.md`](ARCHITECTURE.md).
