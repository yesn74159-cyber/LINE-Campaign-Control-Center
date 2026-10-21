import { createDatabase, getDatabaseErrorDiagnostics, safeDatabaseErrorMessage, type DatabaseErrorType, type DatabaseErrorDiagnostics, type DatabaseStatus } from './db.js';

interface ConnectionCheckResult {
  schemaVersion: 1;
  checker: 'supabase-readonly-connection';
  ok: boolean;
  configured: boolean;
  connected: boolean;
  readOnlySelect: boolean;
  target: string;
  expectedSchema: string;
  currentSchema: string | null;
  searchPath: string | null;
  ssl: boolean | null;
  uuidFunction: boolean;
  poolMode: string;
  errorType: DatabaseErrorType | null;
  errorCode: string | null;
  sslCategory: DatabaseErrorDiagnostics['sslCategory'];
  certificateReason: string | null;
  message: string;
}

function resultFromStatus(status: DatabaseStatus): ConnectionCheckResult {
  const errorType = status.connected ? null : (status.errorType ?? 'Query');
  return {
    schemaVersion: 1,
    checker: 'supabase-readonly-connection',
    ok: false,
    configured: status.configured,
    connected: status.connected,
    readOnlySelect: false,
    target: status.target,
    expectedSchema: status.expectedSchema,
    currentSchema: status.currentSchema ?? null,
    searchPath: status.searchPath ?? null,
    ssl: status.ssl ?? null,
    uuidFunction: status.uuidFunction ?? false,
    poolMode: status.poolMode,
    errorCode: status.errorCode ?? null,
    sslCategory: status.sslCategory ?? null,
    certificateReason: status.certificateReason ?? null,
    errorType,
    message: status.connected ? 'Read-only SELECT has not completed.' : safeDatabaseErrorMessage({ errorType: errorType ?? 'Query', errorCode: status.errorCode ?? null, sslCategory: status.sslCategory ?? null, certificateReason: status.certificateReason ?? null })
  };
}

let database: ReturnType<typeof createDatabase> | null = null;
let result: ConnectionCheckResult;

try {
  database = createDatabase();
  const status = await database.status();
  result = resultFromStatus(status);
  if (status.connected && database.pool) {
    try {
      const readOnlyResult = await database.pool.query<{ read_only_select: number }>('select 1::int as read_only_select');
      result.readOnlySelect = readOnlyResult.rows[0]?.read_only_select === 1;
      if (result.readOnlySelect) {
        result.ok = result.configured && result.connected && result.ssl === true && result.uuidFunction && result.target === 'CLOUD_STAGING' && result.expectedSchema === 'line_ccc' && result.currentSchema === 'line_ccc';
        result.errorType = result.ok ? null : 'Schema';
        result.errorCode = null;
        result.sslCategory = null;
        result.certificateReason = null;
        result.message = result.ok ? 'Read-only PostgreSQL connection is healthy.' : safeDatabaseErrorMessage({ errorType: 'Schema', errorCode: null, sslCategory: null, certificateReason: null });
      }
    } catch (error) {
      const diagnostics = getDatabaseErrorDiagnostics(error);
      result.errorType = diagnostics.errorType;
      result.errorCode = diagnostics.errorCode;
      result.sslCategory = diagnostics.sslCategory;
      result.certificateReason = diagnostics.certificateReason;
      result.message = safeDatabaseErrorMessage(diagnostics);
    }
  }
} catch (error) {
  const diagnostics = getDatabaseErrorDiagnostics(error);
  result = {
    schemaVersion: 1,
    checker: 'supabase-readonly-connection',
    ok: false,
    configured: false,
    connected: false,
    readOnlySelect: false,
    target: process.env.DB_TARGET || 'UNKNOWN',
    expectedSchema: process.env.DB_SCHEMA || 'UNKNOWN',
    currentSchema: null,
    searchPath: null,
    ssl: null,
    uuidFunction: false,
    poolMode: process.env.DB_POOL_MODE || 'UNKNOWN',
    errorType: diagnostics.errorType,
    errorCode: diagnostics.errorCode,
    sslCategory: diagnostics.sslCategory,
    certificateReason: diagnostics.certificateReason,
    message: safeDatabaseErrorMessage(diagnostics)
  };
} finally {
  await database?.close();
}

console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
