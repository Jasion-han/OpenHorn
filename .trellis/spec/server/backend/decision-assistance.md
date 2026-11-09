# Jev Decision Assistance

## Protocol and credentials

The decision client is separate from `ProviderAdapter.chat`. It calls only
`https://openrouter.ai/api/v1/systemone`, requests `typesafe/jev-1.14` and validates
resolved model `typesafe/jev-1.14-20261014`, answer IDs/types, finite probabilities,
option sets and usage. Questions live in `shared/decision-questions`; DTOs live in
`shared/types/decisions`. Future model/question upgrades must keep old stored
batch metadata readable and rerun their evaluations.

The private server credential is `OPENHORN_JEV_API_KEY`, never an ordinary setting
returned to the desktop. Example/Compose files contain placeholders only. Child
environments strip `OPENHORN*`, `OPENROUTER_API_KEY`, and `TYPESAFE_API_KEY`.
The HTTP auth header is separate from state: current/recognized key patterns are
redacted from serialized decision content. This is not general secret detection.

Tests must not inherit paid credentials. The Server preload removes the key;
the production key resolver also refuses `NODE_ENV=test` unless the explicit
synthetic fixture mode is selected. Synthetic mode must own its fake key and
closed fetch surface. Live validation is explicitly invoked with synthetic
content and a task-owned temporary SQLite database.

## Budget, cache and failure semantics

Each local user's durable settings ledger reserves the documented per-request
ceiling before HTTP, then settles actual successful cost once. Unknown billing
retains its reservation. Daily limits reset at UTC midnight; defaults are
$0.05/day, 28 KB and 100 questions per request, five-second HTTP/body timeout
(two seconds for route shadow), no automatic paid retry.

Requests share by user, feature and complete serialized payload. Success cache
TTL is ten minutes; failures cool down per user/feature for 60 seconds. Cache
and cooldown tables are bounded. Joined/cache users report zero extra billed
cost; usage receipts remain separate. Check the master/feature preference before
using a cached result. Missing configuration, disabled, unavailable, timeout,
invalid response, rate limit and exhausted budget are not negative judgments.

## Application boundaries

- Quick reviews are explicit user actions. Persist the pending batch and input
  revisions before inference, dedupe request IDs, hold no SQL transaction over
  HTTP, and recheck the workspace before each paid sub-batch. Final application
  skips changed rows, preserves existing quote/note and cannot recreate a deleted
  workspace. A failed batch changes no annotations. Interrupted pending IDs do
  not automatically replay inference; explicit new runs are distinct actions.
- Review metadata is a bounded extension of existing JSON data, not a new SQL
  schema. Keep old Chat batches/backups readable. Jev labels sentiment and fixed
  topics; it does not generate notes or quotes. Inapplicable/uncertain feedback
  cannot pick arbitrary topics. Display taxonomy IDs through UI translations.
- Existing note verification keeps its evaluated questions, historical v1/v2
  readability and manual behavior. With OpenRouter configured it uses the
  unified client; legacy TypeSafe configuration remains compatible. Preserve the
  actual request model/version in saved/cached provenance.
- Welcome generation may use semantic deduplication after generating candidates.
  Remove only clear duplicates; unavailable judgments use the old filter.
- Server search/RAG reranks existing authorized candidates and retains records.
  RAG evaluates the same 800-character excerpt sent to the answer model, then
  rechecks live ownership after the external await. Oversized/unavailable
  requests preserve the old ordering. Sidecar search tools are not changed.
- Skill suggestions use name/description only, never the path/config fields.
  Keep every enabled skill, put recipe-required skills first and retain explicit
  slash intent; suggestions affect priority and an advisory description only.
- Route shadow collects bounded per-user counts, without prompt logs or changes
  to actual routing. Dataset-only Chat is excluded. It is not a production
  replacement for the regex/generative route pipeline.

See `docs/2026-11-09_jev-integration-results.md` for verified scope and limitations.
