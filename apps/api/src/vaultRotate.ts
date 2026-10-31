import type { Pool } from 'pg';
import { openOaSecret, sealOaSecret, vaultKey } from './lineOaConnect.js';

export type VaultRotationKeys = { oldKey: Buffer; newKey: Buffer };

export type VaultRotationResult = {
  dryRun: boolean;
  database: string;
  scanned: number;
  verified: number;
  updated: number;
  workspaces: number;
};

/**
 * Old key falls back to the current environment key so the operator can rotate
 * in one step: keep LINE_CREDENTIAL_ENCRYPTION_KEY, add ..._NEW, run, then swap.
 */
export function rotationKeys(env: NodeJS.ProcessEnv = process.env): VaultRotationKeys {
  const oldEncoded = (env.LINE_CREDENTIAL_ENCRYPTION_KEY_OLD || env.LINE_CREDENTIAL_ENCRYPTION_KEY || '').trim();
  const newEncoded = (env.LINE_CREDENTIAL_ENCRYPTION_KEY_NEW || '').trim();
  if (!oldEncoded) throw new Error('LINE_CREDENTIAL_ENCRYPTION_KEY_OLD or LINE_CREDENTIAL_ENCRYPTION_KEY must be set');
  if (!newEncoded) throw new Error('LINE_CREDENTIAL_ENCRYPTION_KEY_NEW must be set');
  if (oldEncoded === newEncoded) throw new Error('old and new vault keys must differ');
  return { oldKey: vaultKey(oldEncoded), newKey: vaultKey(newEncoded) };
}

/**
 * Re-seals every OA credential with a new AES-256-GCM key. Default is a dry run
 * that only proves every row can be opened and sealed again; `--confirm` is
 * required before any update. Plaintext never leaves process memory and is
 * never logged. All rows rotate in one transaction or none do.
 */
export async function rotateVault(
  pool: Pool,
  input: { oldKey: Buffer; newKey: Buffer; dryRun?: boolean }
): Promise<VaultRotationResult> {
  const dryRun = input.dryRun !== false;
  if (input.oldKey.length !== 32 || input.newKey.length !== 32) throw new Error('vault keys must be 32 bytes');
  if (input.oldKey.equals(input.newKey)) throw new Error('old and new vault keys must differ');

  const client = await pool.connect();
  try {
    await client.query('begin');
    const database = await client.query<{ name: string }>('select current_database() as name');
    const rows = await client.query<{ workspace_id: string; oa_integration_id: string; token_sealed: string; secret_sealed: string }>(
      'select workspace_id, oa_integration_id, token_sealed, secret_sealed from oa_credential_vault ' +
      'order by workspace_id, oa_integration_id' + (dryRun ? '' : ' for update')
    );

    const workspaces = new Map<string, number>();
    let verified = 0;
    let updated = 0;
    for (const row of rows.rows) {
      let token: string;
      let secret: string;
      try {
        token = openOaSecret(row.token_sealed, row.workspace_id, row.oa_integration_id, 'token', input.oldKey);
        secret = openOaSecret(row.secret_sealed, row.workspace_id, row.oa_integration_id, 'secret', input.oldKey);
      } catch {
        throw new Error('one or more vault rows could not be opened with the old key; nothing was changed');
      }
      const tokenSealed = sealOaSecret(token, row.workspace_id, row.oa_integration_id, 'token', input.newKey);
      const secretSealed = sealOaSecret(secret, row.workspace_id, row.oa_integration_id, 'secret', input.newKey);
      if (
        openOaSecret(tokenSealed, row.workspace_id, row.oa_integration_id, 'token', input.newKey) !== token ||
        openOaSecret(secretSealed, row.workspace_id, row.oa_integration_id, 'secret', input.newKey) !== secret
      ) {
        throw new Error('re-sealed credential failed round-trip verification; nothing was changed');
      }
      verified += 1;
      if (!dryRun) {
        await client.query(
          'update oa_credential_vault set token_sealed=$1, secret_sealed=$2, updated_at=now() ' +
          'where workspace_id=$3 and oa_integration_id=$4',
          [tokenSealed, secretSealed, row.workspace_id, row.oa_integration_id]
        );
        updated += 1;
      }
      workspaces.set(row.workspace_id, (workspaces.get(row.workspace_id) || 0) + 1);
    }

    if (dryRun) {
      await client.query('rollback');
    } else {
      for (const [workspaceId, count] of workspaces) {
        await client.query(
          "insert into audit_log(workspace_id,actor,action,target_type,target_id,detail) " +
          "values ($1,'cli:vault-rotate','OA_VAULT_REKEYED','workspace',$1,$2::jsonb)",
          [workspaceId, JSON.stringify({ detail: 'OA credential vault re-sealed with a new key', credentials: count })]
        );
      }
      await client.query('commit');
    }

    return {
      dryRun,
      database: database.rows[0]?.name || 'unknown',
      scanned: rows.rows.length,
      verified,
      updated,
      workspaces: workspaces.size
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error instanceof Error ? error : new Error('vault rotation failed');
  } finally {
    client.release();
  }
}
