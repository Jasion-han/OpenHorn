# Quality Guidelines

> Code quality standards for frontend development.

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

### Convention: protect markdown code block spacing from base selectors

**What**: When styling desktop markdown code blocks, verify that base descendant selectors such as `.root pre` do not override component-level rules like `.codeScroll`. If a wrapped markdown element needs different spacing, use a scoped selector with matching or higher specificity, for example `.root .codeScroll`.

**Why**: Markdown renderers often emit nested `pre > code` structures. A broad reset rule can silently remove the intended padding from the actual scroll container, making code content sit flush against the panel edge.

---

## Testing Requirements

<!-- What level of testing is expected -->

(To be filled by the team)

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
