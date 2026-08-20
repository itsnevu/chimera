# Cost control

Every guard standing between you and a surprise bill, in the order you meet
them.

## The ceiling

```js
// src/ai.config.js
maxSpendUSD: 50,
```

A **hard ceiling**, not a warning. There is no prompt to override it — you
raise the number deliberately or the run stops.

Set it to `0` to permit only the free `mock` provider.

Override for a single run: `--max-spend 5`

## Where it is enforced

**1. Planning.** `ai:plan` refuses to write an over-budget plan and tells you
what would fit:

```
ERROR  this run would cost $230.00, above your ceiling of $50.00.
       Nothing was written. Choose one:
         - lower --size (1086 editions fits)
         - pick a cheaper --model
         - raise maxSpendUSD in src/ai.config.js deliberately
```

Nothing is written. An existing `plan.json` is left untouched.

**2. Before a run starts.** `ai:generate` projects `already spent + remaining ×
unit cost` and refuses if that crosses the ceiling.

**3. Before every single render.** The worker pool polls `shouldStop()` before
each task. A live run halts the moment the *next* call would cross the line:

```
HALTED at the $50.00 ceiling. Completed work is in the ledger;
raise maxSpendUSD and re-run to continue where this stopped.
```

Work already done stays in the ledger, so raising the ceiling and re-running
continues rather than restarting.

## Explicit confirmation

Any paid run requires `--yes`. Without it the command prints the bill and
exits:

```
This will spend up to $40.00 of your own credit.
Re-run with --yes to proceed.
```

## The ledger — never pay twice

`build/ai/ledger.jsonl` is append-only and `fsync`'d on every write. It is the
sole authority on what has been paid for.

- **Resume** skips everything in it. Verified: a run killed with `kill -9` at
  edition 212 resumed and rendered exactly the remaining 788, ending with 1,000
  unique entries and zero duplicates.
- **A torn final line** from a hard kill is skipped on read. You lose one
  image, not the run.
- **Failures are not recorded**, so a failed edition is retried on the next run
  without you tracking anything.

## Never delete what you paid for

`buildSetup()` used to call `fs.rmSync(buildDir, {recursive: true})`
unconditionally. In AI mode that deletes images you paid for. It now refuses:

```
Refusing to clear .../build: an AI run ledger exists at .../build/ai/ledger.jsonl.
Those images were paid for. Move them, or pass --force to wipe anyway.
```

`ai:requeue` — the only tool that rewrites the ledger — timestamps a backup
first and **moves** rejects to `build/ai/rejects/` rather than deleting them.

## Retry policy

Retrying a bad request spends money on the same mistake:

| Status | Retried? | Why |
|---|---|---|
| 429 | yes, backoff + jitter | transient rate limit |
| 5xx | yes | provider-side fault |
| 4xx | **no** | our request is wrong; three retries is three wasted calls |
| network / timeout | yes | transient |

## Rate limiting

A token bucket sits in front of the worker pool. Burst defaults to **one
second** of headroom, not one minute.

That default is deliberate. A bucket initialised with a full minute of tokens
lets 600 requests leave in the first second — precisely how you trip the
600/min limit it exists to respect. The bug was caught by a test that expected
throttling and measured 0 ms.

## Spend accounting cannot go NaN

Where a provider reports actual spend (`usage.cost`), the ledger records that
rather than the catalogue estimate. Where it reports nothing, the catalogue
price is used.

That fallback exists because `spent += null` produces `NaN`, and `NaN > ceiling`
is always `false` — **the ceiling would silently stop working.** A test asserts
the running total stays finite through `null`, `undefined` and `NaN`.

## Where money actually goes

| Stage | Cost at 1,000 editions, Seedream 4.5 |
|---|---|
| doctor, plan, finalize | $0 |
| mock full run | $0 |
| style bible master | ~$0.04 |
| anchors (optional) | ~$0.08 |
| smoke test | ~$0.20 |
| full generate | $40.00 |
| +15% reroll allowance | **$46.00 — plan for this** |
| QC free tier | $0 |
| QC trait verification | varies by vision model |

**Total risk before the go/no-go decision: about $0.32.**
