import test from 'node:test';
import assert from 'node:assert/strict';
import { runAdminAccountMigration } from '../worker/admin-account-migration.mjs';
import { verifyPassword } from '../worker/passwords.mjs';

test('admin migration preserves the user id, removes the personal email, resets the password, and revokes sessions', async () => {
  const user = { id: 'admin-id', email: 'old@example.invalid', english_name: 'Old Name', role: 'admin', status: 'verified' };
  const values = new Map([
    ['session:mine', user.id],
    ['session:other', 'other-id']
  ]);
  let updateArgs;
  const env = {
    ADMIN_ACCOUNT_MIGRATION_SOURCE: user.email,
    ADMIN_ACCOUNT_MIGRATION_PASSWORD: 'new-test-password',
    SESSIONS: {
      get: async key => values.get(key) || null,
      put: async (key, value) => values.set(key, value),
      delete: async key => values.delete(key),
      list: async () => ({ keys: [...values.keys()].filter(key => key.startsWith('session:')).map(name => ({ name })), list_complete: true })
    },
    DB: {
      prepare(sql) {
        const statement = {
          bind(...args) {
            if (sql.startsWith('update users set')) updateArgs = args;
            statement.args = args;
            return statement;
          },
          first: async () => {
            if (sql.includes('lower(email)=?')) return user;
            if (sql.includes('id != ?')) return null;
            return null;
          },
          run: async () => ({ meta: { changes: 1 } })
        };
        return statement;
      }
    }
  };

  const result = await runAdminAccountMigration(env);
  assert.equal(result.status, 'migrated');
  assert.equal(result.userId, user.id);
  assert.match(updateArgs[0], /^admin-[a-f0-9]{24}@system\.local$/);
  assert.equal(updateArgs[1], 'anon2221');
  assert.equal(await verifyPassword('new-test-password', updateArgs[2]), true);
  assert.equal(updateArgs.includes('old@example.invalid'), true);
  assert.equal(values.has('session:mine'), false);
  assert.equal(values.get('session:other'), 'other-id');
  const marker = JSON.parse(values.get('maintenance:admin-username-migration-v1'));
  assert.equal(marker.userId, user.id);
  assert.equal(JSON.stringify(marker).includes('old@example.invalid'), false);
});

test('admin migration refuses to promote a non-admin account', async () => {
  const env = {
    ADMIN_ACCOUNT_MIGRATION_SOURCE: 'student@example.invalid',
    ADMIN_ACCOUNT_MIGRATION_PASSWORD: 'new-test-password',
    SESSIONS: { get: async () => null },
    DB: { prepare: () => ({ bind() { return this; }, first: async () => ({ id: 'student', role: 'student' }) }) }
  };
  await assert.rejects(runAdminAccountMigration(env), /not an admin/);
});

