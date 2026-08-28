# Show Code Copy Button On Hover

## Goal

Code block copy controls should stay hidden until the user points at or focuses within the code block.

## Scope

- Update markdown code block UI in the web app.
- Update markdown code block UI in the desktop app.
- Preserve keyboard accessibility: the copy button must be visible when focused.
- Do not change markdown parsing or clipboard behavior.

## Acceptance Criteria

- Copy button is not visually shown in an idle code block.
- Copy button appears when hovering over the code block area.
- Copy button appears when keyboard focus is inside the code block or on the copy button.
- Existing copied-state text and icons continue to work.
