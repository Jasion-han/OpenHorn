import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalizeWorkspaceRoot } from './workspace';
import { fsList, fsReadText, fsWriteText } from './fs';

describe('fs', () => {
  test('lists entries and hides .openhorn', async () => {
    const root = await canonicalizeWorkspaceRoot(mkdtempSync(path.join(os.tmpdir(), 'openhorn-ws-')));
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, '.openhorn'));
    writeFileSync(path.join(root, 'src', 'a.txt'), 'hi');

    const { entries } = await fsList({ workspaceRoot: root, dir: '.' });
    expect(entries.some((e) => e.name === '.openhorn')).toBe(false);
    expect(entries.some((e) => e.name === 'src' && e.kind === 'dir')).toBe(true);
  });

  test('reads and writes text', async () => {
    const root = await canonicalizeWorkspaceRoot(mkdtempSync(path.join(os.tmpdir(), 'openhorn-ws-')));
    await fsWriteText({ workspaceRoot: root, filePath: 'a.txt', content: 'hello' });
    const { content } = await fsReadText({ workspaceRoot: root, filePath: 'a.txt' });
    expect(content).toBe('hello');
  });
});

