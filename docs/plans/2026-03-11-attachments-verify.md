## Attachments Manual Verification

### Prerequisites

- Server running on `http://localhost:3000`
- Web app running on `http://localhost:3001`
- A default channel and model configured

### Chat

1. Open Chat page.
2. Create or select a conversation.
3. Click `Attach`, upload a small `.txt` file with known content.
4. Send a short message: “请总结附件内容”.
5. Verify assistant references the attachment text.

### Agent

1. Open Settings → Agent, select a workspace.
2. Create a new agent session.
3. Click `Attach`, upload a small `.txt` or `.pdf`.
4. Run: “基于附件内容生成三条要点”.
5. Verify output references the attachment.
