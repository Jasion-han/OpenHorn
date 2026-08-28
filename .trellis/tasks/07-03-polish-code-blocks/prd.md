# Polish desktop code block styling

## Problem

Desktop chat markdown code blocks look visually flat and cramped. In particular, code content sits too close to the panel edge because the base `.root pre` rule overrides the intended `.codeScroll` padding.

## Goals

- Restore comfortable inner padding for fenced code blocks.
- Improve code block visual hierarchy with a calmer surface, border, header, and copy control.
- Keep the change scoped to desktop markdown rendering.
- Preserve existing copy behavior and markdown rendering.

## Non-goals

- No markdown parser changes.
- No web app styling changes.
- No new dependencies.

## Acceptance criteria

- Fenced code blocks have visible left/right padding and no longer touch the border.
- Header, language label, and copy button are aligned and polished.
- Long code remains horizontally scrollable.
- Desktop TypeScript build passes.
