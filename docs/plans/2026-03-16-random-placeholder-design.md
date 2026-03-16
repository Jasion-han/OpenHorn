# Random Creative Placeholder Design

**Context**

Chat and Agent currently show different placeholder strings in the composer. The goal is to unify them into a shared set of high-quality English placeholders that feel “alive” by rotating on key UI events.

## Goals

- Use a single pool of 30 English, creative/light placeholders.
- Randomize on page refresh, conversation switch, and input focus.
- Do not overwrite the placeholder while the user is typing.
- Keep logic purely client-side.

## Non-Goals

- Persisting placeholders server-side.
- Localizing placeholders.
- Introducing heavy randomness logic or analytics.

## UX Rules

- Randomize on initial render (page refresh).
- Randomize on conversation change, only if the input is empty.
- Randomize on input focus, only if the input is empty.
- Avoid repeating the immediately previous placeholder when possible.

## Architecture

- Store the placeholder pool in `ChatArea`.
- Maintain `placeholder` state and a `pickPlaceholder()` helper.
- Pass the placeholder into `PromaComposer`.
- Add an `onInputFocus` prop to `PromaComposer` and wire it to the textarea `onFocus`.

## Testing

- Web typecheck to ensure props and handlers are wired correctly.
- No new automated UI tests required for this iteration.

## Rollout

- This is a UI-only change and can be deployed as-is.
