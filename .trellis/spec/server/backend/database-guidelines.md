# Database Guidelines

> Database patterns and conventions for this project.

---

## Overview

<!--
Document your project's database conventions here.

Questions to answer:
- What ORM/query library do you use?
- How are migrations managed?
- What are the naming conventions for tables/columns?
- How do you handle transactions?
-->

(To be filled by the team)

---

## Query Patterns

- Project creation must handle concurrent insertion against the existing
  `(user_id, root_path)` unique index and return the canonical row. A preliminary
  existence read alone does not provide deduplication. See `projectService.test.ts`.
- MCP configuration edits persist the supplied transport type as well as config.
  Validate object input, nonempty bounded name/type, object config and boolean
  enable state before writes. Malformed writes must leave the existing row intact;
  ownership-scoped queries still apply. See `mcpService.test.ts`.
- Upload files are created exclusively and cleaned on a rejected metadata insert
  only when the database confirms no row was committed. Never remove an older
  file or a possibly committed blob after an uncertain acknowledgement/read.
  Verify normal success, rejection and lost acknowledgement in isolated processes
  with temporary files/databases (`attachmentService.failure.test.ts`).
- Embedding credentials come only from the caller's enabled OpenAI-compatible
  protocol channels. CLI OAuth markers are skipped while searching later API-key
  candidates; do not fall back to Anthropic/Google/ACP credentials.

- The current RAG index requires one 1536-dimensional finite-number vector per
  input. Indexed embedding responses must be reordered and validated; all-indexless
  compatible responses may retain array order, but mixed/duplicate/out-of-range
  indices reject the whole batch. Requests have a 15-second default timeout through
  body consumption; optional caller cancellation reaches the HTTP request.
- Welcome recommendation reads remain nonblocking and retain stale cache. Automatic
  refresh uses a per-user in-flight gate and a 60-second cooldown after failure or
  empty results. This coordination is process-local; it is not a durable job queue.

- Document chunks stay within 2800 UTF-16 code units, prefer paragraph/line/word
  boundaries, and retain approximately 200 units of overlap without splitting
  surrogate pairs. Oversized single paragraphs must be subdivided too.
- Vector-store instances share pending connection and table-initialization promises,
  release failures for retry, and open an existing table when another instance
  wins creation. Never overwrite the table to resolve a creation race. Temporary
  real-LanceDB regressions cover concurrent first writes and delete/re-add.
- Settings result dictionaries preserve special names such as `__proto__` as own
  string properties, including JSON round trips, rather than object prototype keys.

<!-- How should queries be written? Batch operations? -->

(To be filled by the team)

---

## Migrations

<!-- How to create and run migrations -->

(To be filled by the team)

---

## Naming Conventions

<!-- Table names, column names, index names -->

(To be filled by the team)

---

## Common Mistakes

<!-- Database-related mistakes your team has made -->

(To be filled by the team)
