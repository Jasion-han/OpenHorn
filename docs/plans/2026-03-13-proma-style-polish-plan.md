# Proma Style Polish Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Polish shared UI components to match Proma “feel” without changing page structure or behavior.

**Architecture:** Update shared shadcn/radix wrappers in `packages/ui` so both Web and Desktop benefit; keep changes to Tailwind classes only.

**Tech Stack:** React, Radix UI, Tailwind CSS, shadcn/ui patterns, Next.js (Web), Tauri (Desktop).

---

### Task 1: Align `Dialog` with Proma (desktop-safe drag behavior)

**Files:**
- Modify: `packages/ui/src/components/ui/dialog.tsx`

**Step 1: Update overlay/content classes**
- Add `titlebar-no-drag` to `DialogOverlay` and `DialogContent` className strings.

**Step 2: Typecheck**
Run: `pnpm --filter web typecheck`
Expected: PASS

**Step 3: Build**
Run: `pnpm --filter web build`
Expected: PASS

---

### Task 2: Align `DropdownMenu` transform-origin + long list behavior

**Files:**
- Modify: `packages/ui/src/components/ui/dropdown-menu.tsx`

**Step 1: Update Content/SubContent classnames**
- Add `origin-[--radix-dropdown-menu-content-transform-origin]` to `DropdownMenuContent` and `DropdownMenuSubContent`.
- Add `max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto overflow-x-hidden` to `DropdownMenuContent`.

**Step 2: Typecheck**
Run: `pnpm --filter web typecheck`
Expected: PASS

---

### Task 3: Align `Select` content styling + transform-origin

**Files:**
- Modify: `packages/ui/src/components/ui/select.tsx`

**Step 1: Update `SelectContent` classes**
- Switch `bg-popover text-popover-foreground` -> `bg-card text-card-foreground`
- Add `origin-[--radix-select-content-transform-origin]` and `titlebar-no-drag`

**Step 2: Typecheck**
Run: `pnpm --filter web typecheck`
Expected: PASS

---

### Task 4: Optional minor polish (Tooltip/Separator/ScrollArea)

**Files:**
- Modify (if needed): `packages/ui/src/components/ui/tooltip.tsx`
- Modify (if needed): `packages/ui/src/components/ui/separator.tsx`
- Modify (if needed): `packages/ui/src/components/ui/scroll-area.tsx`

**Step 1: Diff against Proma patterns**
- Keep changes minimal and token-based.

**Step 2: Typecheck**
Run: `pnpm --filter web typecheck`
Expected: PASS

