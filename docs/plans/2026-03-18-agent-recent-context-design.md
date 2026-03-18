# Agent Recent Context Design

**Goal:** Make `Agent` mode understand short follow-up questions in the same conversation by injecting recent dialogue context into the agent prompt.

**Scope**
- Include recent `user` / `assistant` text messages from the current conversation when running Agent mode.
- Keep the first version bounded to the latest 8 messages before the current turn.
- Exclude historical tool traces, live badges, citations, and historical attachments.

**Why**
- `Chat` mode already sends prior messages to the model.
- `Agent` mode currently sends only the current turn prompt, so follow-ups like “那他能做什么” lose reference resolution.

**Approach**
- Build recent conversation context in `messageService.ts` for Agent send/edit/regenerate flows.
- Pass the normalized history into `runAgentWithConfig(...)` as a new optional field.
- In `agentService.ts`, prepend a compact `Recent conversation context:` block before the current `Task:`.

**History Rules**
- Source only from the current conversation and only messages before the current assistant reply.
- Limit to the most recent 8 non-empty text messages.
- Include only message role + plain text content.
- Skip placeholder or empty assistant content.

**Non-Goals**
- No UI changes.
- No configuration switch in this iteration.
- No replay of historical attachments or old agent tool events.

**Validation**
- Add a server test proving Agent mode follow-up turns receive prior context.
- Keep existing chat-mode behavior unchanged.
