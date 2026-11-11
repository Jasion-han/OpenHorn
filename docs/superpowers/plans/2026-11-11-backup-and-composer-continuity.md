# Backup and composer continuity

Continue the confirmed reliability work, preserving the current UI and unrelated working changes.

- Use one bounded ZIP policy for both export and restore: 128 MiB per entry, 512 MiB total uncompressed, 20,000 entries. Check serialized metadata and file sizes before export, then enforce actual streamed bytes so a source growing after preflight cannot yield an unusable successful backup. Return a typed, localized size error and remove incomplete output.
- Retain ordinary conversation composer text and pending File handles in memory under backend/account/conversation identity. Navigation restores the correct draft; logout/backend changes and app restart clear it. Never auto-send restored drafts. A repeated editable handoff must preserve the user's edited text. Late attachment completion only clears its original files in its original conversation.
- Validate oversized sparse-file rejection and normal ZIP round trips, owner-bound draft mutations, actual browser navigation and repeated handoffs. Run focused tests and type/format checks. No automatic commit or deployment.
