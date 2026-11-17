# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

This directory contains guidelines for backend development. Fill in each file with your project's specific conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Database Guidelines](./database-guidelines.md) | ORM patterns; conflict-safe project creation and validated MCP writes | Partial |
| [Error Handling](./error-handling.md) | Error types, handling strategies | To fill |
| [Quality Guidelines](./quality-guidelines.md) | Code standards; isolated encryption-backed test fixtures | Partial |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | To fill |
| [Decision Assistance](./decision-assistance.md) | OpenRouter Jev protocol, budget and application boundaries | Complete |
| [Chat Streaming](./chat-streaming.md) | Partial output, terminal failures and persistence before SSE completion | Complete |
| [Project Library](./project-library.md) | Owned project originals, local keyword indexes, frozen Chat sources and backup scopes | Complete |
| [Search and Versions](./search-and-versions.md) | User-scoped unified keyword search and immutable CAS version restoration | Complete |
| [Provider Tools](./provider-tools.md) | Shared Search/Fetch, native Chat state, completion snapshots and DeepSeek import | Complete |

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
