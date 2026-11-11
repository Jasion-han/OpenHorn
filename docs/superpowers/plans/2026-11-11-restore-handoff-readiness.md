# Restore retries, welcome handoff and readiness

1. Restore each new conversation and its messages atomically. Persist an owned archive/conversation checkpoint in the same transaction; use it to resume only that archive's missing attachments, recording completed attachment identities atomically. Preserve existing user content and report incomplete legacy imports rather than falsely succeeding.
2. Bind the welcome prompt only after create returns a target, immediately before selecting that target. Fence creation by navigation/identity, preserve an abandoned creation as an unsent conversation draft, and never let an unbound prompt auto-send.
3. Load identity before owned data. Required data failure blocks ready; retry failed groups without reloading successful groups from the same recovery/identity. Keep recommendations/prompts optional; do not start recovery or scheduled work until required groups succeed.
4. Validate with isolated SQLite interruption/retry cases, late welcome creation and normal handoff browser flows, failed initial load/retry tests, then focused and type/format checks. No real data operations, model calls, commits or deployment.
