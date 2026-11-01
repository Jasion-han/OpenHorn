# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

<!-- Patterns that should never be used and why -->

(To be filled by the team)

---

## Required Patterns

<!-- Patterns that must always be used -->

(To be filled by the team)

---

## Testing Requirements

### Encryption-backed database fixtures

1. **Scope / trigger:** a service test inserts an encrypted channel key for an
   operation that does not later decrypt that fixture, such as deletion. It
   must run independently of a developer's `.env` or another test's key.
   Tests that require decryption should use an isolated process-level synthetic
   key throughout that test instead of this temporary-key pattern.
2. **Signatures:** `encrypt(text: string): string` reads
   `process.env.ENCRYPTION_KEY` synchronously. `src/test-setup.ts`, loaded by
   `bunfig.toml`, redirects the database before service imports.
3. **Contracts:** own a fixed synthetic encryption key only while constructing
   the fixture; restore the exact previous value in `finally`, before any
   `await`. Never use a real provider key or weaken production key validation.
   `OPENHORN_TEST_DATABASE_URL` explicitly selects an isolated test database;
   ambient `DATABASE_URL` is intentionally overridden by the preload.
4. **Validation / errors:** with no prior key, restore the missing variable;
   with a prior key, restore it byte-for-byte; on encryption failure, restore
   in `finally`. Production `encrypt` still throws when the key is missing.
   Its derived-key cache is keyed by secret, so restoring a secret must not
   reuse the fixture's derived key.
5. **Cases:** absent-key and existing-synthetic-key runs both pass. A test that
   succeeds only because local `.env` supplies the secret is incomplete.
6. **Required checks:** run the single service test with `.env` disabled and
   `ENCRYPTION_KEY` absent, repeat with an existing synthetic key, then run the
   full Server suite. Assert environment restoration and actual service effects.
   Use separate `OPENHORN_TEST_DATABASE_URL` paths for concurrent runners.
7. **Wrong / correct:** do not leave a test secret installed across database
   awaits. Use the synchronous fixture pattern in
   `src/services/channelService.delete.test.ts`:

   ```ts
   const previous = process.env.ENCRYPTION_KEY;
   process.env.ENCRYPTION_KEY = "channel-delete-test-encryption-key";
   try {
     return encrypt("k");
   } finally {
     if (previous === undefined) delete process.env.ENCRYPTION_KEY;
     else process.env.ENCRYPTION_KEY = previous;
   }
   ```

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
