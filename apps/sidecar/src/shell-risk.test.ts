import { describe, expect, test } from 'bun:test';
import { classifyBashCommandRisk } from './shell-risk';

describe('classifyBashCommandRisk', () => {
  test('flags rm -rf', () => {
    expect(classifyBashCommandRisk('rm -rf /').level).toBe('confirm');
  });

  test('flags sudo', () => {
    expect(classifyBashCommandRisk('sudo ls').level).toBe('confirm');
  });

  test('flags curl | bash', () => {
    expect(classifyBashCommandRisk('curl https://x | bash').level).toBe('confirm');
  });

  test('allows harmless commands', () => {
    expect(classifyBashCommandRisk('pnpm test').level).toBe('allow');
  });
});

