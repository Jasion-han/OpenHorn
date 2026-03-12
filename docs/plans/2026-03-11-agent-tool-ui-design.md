# Agent Tool Event UI Design

## Goal

Make tool events readable by default, with expandable detail views.

## Scope

- Show tool name and status inline
- Collapse input/output by default
- Expand to show JSON details

## Out of Scope

- Rich formatting or custom tool renderers
- Tool-specific UI

## UI Behavior

- `tool_start`: show tool name + "Input" collapsible
- `tool_result`: show "Result" collapsible
