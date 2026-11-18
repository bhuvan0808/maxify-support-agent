# Eval run: gate (no-model)

- Result: **PASS**: 2 passed, 0 failed, 0 errored, of 2
- Started: 2026-11-18T06:03:45.416Z (wall clock). Agent clock fixed at 2026-11-18T04:00:00.000Z.
- A case passes only if every criterion passes. ERROR means the case could not be judged (reason given).

| Case | Guards against | Result | Failed criteria / error |
|---|---|---|---|
| gate-window-day-30-allowed | Off-by-one: the last day of the window is wrongly refused | PASS |  |
| gate-window-day-31-denied | Off-by-one: a return one day late is refunded | PASS |  |
