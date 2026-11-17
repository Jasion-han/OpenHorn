# Composer sizing and caret

Fix the reported existing composer without changing its layout or adding controls.

- Size the native textarea to its content between the current minimum/maximum heights; shrink on delete/clear and remeasure after width/font changes. Above the cap, scroll the current insertion position into its own viewport without forcing the selection to the end.
- Render ordinary text natively. Use the slash-highlight mirror only when needed, with matching typography, wrapping and measured client width/height; suspend the mirror during IME composition.
- Preserve external input refs, IME/Enter semantics, manual selection, attachments and command interactions. Apply shared sizing to the welcome input as well.
- Verify long Chinese/Latin text, newlines, narrowing, clear/shrink, selection in the middle and composition. Check the real native surface after rebuilding while preserving unsent content and avoiding model calls.
