# Web Agent Product Definition

Date: 2026-03-20
Status: Drafted and aligned in conversation
Scope: OpenHorn web client

## 1. Purpose

This document defines what `Agent` means in the web version of OpenHorn, how it differs from `Chat`, what kinds of work it should actually complete, and what it should explicitly not promise in a browser-only environment.

The goal is to keep product, design, and implementation aligned around one core rule:

- `Chat` is for answering.
- `Agent` is for completing tasks.

Both modes live inside the same conversation UI. They are not two separate products.

## 2. Primary Product Shape

OpenHorn should follow a single-entry interaction model:

- `/chat` is the main product surface.
- `Chat / Agent` is a mode switch inside the same composer.
- Users stay in the same conversation while changing working mode.
- Context should remain continuous across mode switches.

This is intentionally closer to Cursor's interaction model than to a separate "chat page + agent page" split.

## 3. Chat vs Agent

### 3.1 Chat

`Chat` is optimized for short-cycle interaction.

Characteristics:

- Centers on the current reply.
- Prioritizes speed, clarity, and conversational flow.
- Usually ends when the answer is delivered.
- May use live capabilities when needed, but the user mainly cares about the answer.

Typical examples:

- Explain a concept.
- Rewrite a paragraph.
- Summarize an article.
- Answer a factual question.
- Give advice or brainstorm ideas.

### 3.2 Agent

`Agent` is optimized for task completion.

Characteristics:

- Centers on a goal, not just the next reply.
- Can move through multiple phases: understand, plan, execute, verify, deliver.
- Has explicit status and lifecycle.
- Can pause, wait for approval, continue, retry, or replan.
- Should produce a usable deliverable, not just a conversational answer.

Typical examples:

- Research a topic across multiple sources and deliver a structured result.
- Extract information from documents or webpages.
- Produce a report, brief, plan, or artifact after several steps.
- Run a service-side workflow that may need user approval partway through.

## 4. Core Product Principle

If a capability does not meaningfully improve task completion over normal chat, it should not be labeled `Agent`.

To qualify as `Agent`, a flow should usually have at least some of the following:

- A persistent goal.
- Multiple phases or steps.
- Visible status.
- Recoverability: continue, retry, replan.
- Intermediate process value: plan, progress, approvals, execution trace.
- A clear final deliverable.

If none of these are present, the experience is probably still `Chat`.

## 5. What Web Agent Can Truly Do

Web Agent should focus on work that is genuinely strong in a browser and can be backed by online data or server-side tools.

### 5.1 Online Research Work

Best-fit tasks:

- Multi-source research.
- Product and competitor comparison.
- Topic monitoring and synthesis.
- News, policy, and market information gathering.
- Structured extraction from webpages or PDFs.

Why it fits web:

- The information is already online.
- Sources can be cited and traced.
- Results can be delivered as summaries, reports, or structured outputs.

### 5.2 Content Production Work

Best-fit tasks:

- Drafting plans, briefs, emails, PRDs, and proposals.
- Turning scattered notes into a clean deliverable.
- Rewriting, polishing, translating, and restructuring documents.
- Converting gathered information into a usable artifact.

Why it fits web:

- It benefits from planning, iteration, and final delivery.
- It does not require direct local machine control.

### 5.3 Service-Side Tool Orchestration

Best-fit tasks:

- Calling MCP tools.
- Querying private or internal data sources exposed through approved backends.
- Running remote workflows.
- Performing approval-gated task execution.
- Coordinating service-side automations and long-running jobs.

Why it fits web:

- Execution can happen on the server.
- The browser only needs to show state, approvals, and results.

## 6. What Web Agent Should Not Pretend To Be

Browser-only Agent should not implicitly promise full local-computer autonomy.

Web Agent is not the right place to promise:

- Direct control of the user's local computer.
- Opening local IDEs or desktop apps.
- Stable local file system automation.
- General-purpose OS-level automation.
- Broad, unrestricted browser-side control across arbitrary logged-in sites.

These require capabilities outside a normal web client, such as:

- Browser extensions.
- Remote browser automation infrastructure.
- Local companion apps or daemons.
- Desktop shells.

This limitation should be treated as a product boundary, not a missing checkbox.

## 7. What Makes Web Agent Valuable

The web version should win by being an `online task agent`, not by being a weak imitation of a desktop agent.

Its real value should come from:

- Better task structure than chat.
- Better recoverability than chat.
- Better deliverables than chat.
- Better visibility into process and status than chat.
- Better integration with online and service-side tools than chat.

## 8. Interaction Model Inside `/chat`

The main user flow should remain inside the conversation page.

### 8.1 Main Entry

- User writes inside the existing composer.
- User switches mode between `Chat` and `Agent`.
- The same conversation continues regardless of mode.

### 8.2 Agent Message Card

An assistant response in `Agent` mode should evolve into a task card embedded in the message stream.

Default collapsed view:

- Final answer or current state summary.
- Task status badge.
- Minimal metadata.

Expanded view:

- Plan.
- Approval state.
- Execution progress or trace.
- Final result and artifacts.
- Sources when relevant.

Inline actions:

- Approve.
- Reject.
- Continue.
- Retry.
- Replan.
- Optionally: open in advanced workbench.

## 9. Role of `/agent`

The standalone `/agent` surface should not remain the main user-facing Agent workflow.

Recommended role:

- Advanced workbench.
- Debug and inspection surface.
- Power-user or internal operations view.
- Rich multi-task overview if needed later.

Recommended non-role:

- Not the default entry for ordinary Agent usage.
- Not the canonical place where a normal user must go to finish an Agent task.

## 10. Product Rules For Future Development

When evaluating any new Agent feature for the web product, use these rules:

1. Does this help complete a task, not just answer a prompt?
2. Can this be delivered naturally inside the existing conversation flow?
3. Does it produce visible task structure, status, recovery, or deliverables?
4. Is it genuinely feasible in a browser-only environment?
5. If it really needs local-machine control, should it be postponed to desktop?

If the answer to 2 is "no", the feature likely does not fit the current product shape.
If the answer to 4 is "no", the feature should not be forced into the web roadmap.

## 11. Near-Term Build Priorities

Given this definition, the next priority for the web product should be to move core Agent affordances into the chat stream itself.

Recommended order:

1. Embedded Agent message card in `/chat`.
2. Inline plan and approval handling inside the message card.
3. Inline continue, retry, and replan actions.
4. Message-level task/run association.
5. Optional deep-link from a message card into the advanced workbench.

## 12. One-Sentence Definition

OpenHorn Web Agent is a task-oriented mode inside the normal conversation UI, designed to complete online and service-side work through planning, execution, approvals, recovery, and deliverables, without pretending to be a full desktop automation agent.
