import { test, expect } from 'bun:test';
import * as schema from 'db';

test('server imports schema from workspace db package', () => {
  expect(schema.users).toBeTruthy();
  expect(schema.conversations).toBeTruthy();
});

