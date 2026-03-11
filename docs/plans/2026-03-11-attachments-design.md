# Attachments Phase Design

## Goal

Add attachments support for Chat and Agent (images, PDF, text). Store files on server filesystem and parse text for prompt injection.

## Scope

- Upload API
- File storage under `data/attachments/{conversationId}/`
- Parsing for images/PDF/text
- Message send uses attachment ids
- Allowed types: `png/jpg/webp/pdf/txt/md`
- Size limit: 20MB per file

## Out of Scope

- Office formats
- Rich previews
- Streaming attachments

## Data Flow

1. Upload files → receive attachment ids
2. Send Chat/Agent message with attachment ids
3. Server loads attachments, extracts text, injects into prompt

## Error Handling

- Skip invalid attachment parsing
- Upload failures stop send
