# Random Creative Placeholder Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the default composer placeholders with a shared pool of 30 creative English lines, randomized on refresh, conversation switch, and input focus.

**Architecture:** Keep the placeholder pool and randomization logic in `ChatArea`, pass the selected placeholder into `PromaComposer`, and trigger a refresh on focus only when the input is empty.

**Tech Stack:** React (Next.js), Zustand, TypeScript.

---

### Task 1: Add Placeholder Pool And Randomizer In ChatArea

**Files:**
- Modify: `apps/web/src/components/ChatArea.tsx`

**Step 1: Write the placeholder pool and helper**

Add:
- a `PLACEHOLDERS` array with 30 English strings
- a `pickPlaceholder()` helper that avoids repeating the previous value when possible
- `placeholder` state initialized to a random value

**Step 2: Wire refresh triggers**

Add effects:
- on initial render (already via `useState` initializer)
- on conversation switch (`currentConversation?.id`)
  - only change placeholder if input is empty

**Step 3: Commit**

```bash
git add apps/web/src/components/ChatArea.tsx
git commit -m "feat(web): add random placeholders"
```

### Task 2: Add Focus Trigger In PromaComposer

**Files:**
- Modify: `apps/web/src/components/composer/PromaComposer.tsx`

**Step 1: Add prop**

Add a new optional prop:

```ts
onInputFocus?: () => void;
```

**Step 2: Wire it to textarea**

Attach `onFocus` to the textarea:

```tsx
onFocus={() => onInputFocus?.()}
```

**Step 3: Commit**

```bash
git add apps/web/src/components/composer/PromaComposer.tsx
git commit -m "feat(web): refresh placeholder on focus"
```

### Task 3: Connect Focus Trigger And Validate

**Files:**
- Modify: `apps/web/src/components/ChatArea.tsx`

**Step 1: Pass handler**

Pass `onInputFocus` to `PromaComposer`, and only randomize when input is empty.

**Step 2: Run typecheck**

Run: `pnpm --filter web typecheck`  
Expected: PASS

**Step 3: Commit**

```bash
git add apps/web/src/components/ChatArea.tsx
git commit -m "feat(web): wire placeholder focus randomizer"
```
