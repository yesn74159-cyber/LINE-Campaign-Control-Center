import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresRepository } from '../dist/api/repository.js';

const row = (workspaceId, id) => ({
  id,
  workspace_id: workspaceId,
  email: 'shared@example.test',
  display_name: 'Staff',
  role: 'owner',
  password_hash: 'not-a-real-hash',
  active: true
});

test('password login fails closed when email exists in two workspaces', async () => {
  const pool = { query: async (sql) => {
    assert.match(sql, /limit 2/i);
    return { rows: [row('workspace-a', 'user-a'), row('workspace-b', 'user-b')] };
  } };
  const user = await createPostgresRepository(pool).getUserByEmail('shared@example.test');
  assert.equal(user, null, 'Ambiguous email must never authenticate one arbitrary workspace');
});

test('existing single-workspace login remains compatible', async () => {
  const pool = { query: async (sql) => {
    assert.match(sql, /limit 2/i);
    return { rows: [row('workspace-a', 'user-a')] };
  } };
  const user = await createPostgresRepository(pool).getUserByEmail('shared@example.test');
  assert.equal(user?.id, 'user-a');
  assert.equal(user?.workspaceId, 'workspace-a');
});