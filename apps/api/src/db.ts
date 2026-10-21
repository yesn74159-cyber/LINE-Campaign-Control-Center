import fs from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

export type DatabaseTarget = 'LOCAL_DEV' | 'CLOUD_STAGING';
export type DatabaseSslMode = 'disable' | 'require' | 'verify-full';
export type DatabaseErrorType = 'Authentication' | 'DNS' | 'SSL' | 'Network' | 'Schema' | 'Query';
export type SslDiagnosticCategory = 'CertificateTrust' | 'HostnameVerification' | 'TlsHandshake' | 'Network';

export interface DatabaseErrorDiagnostics {
  errorType: DatabaseErrorType;
  errorCode: string | null;
  sslCategory: SslDiagnosticCategory | null;
  certificateReason: string | null;
}

export interface DatabaseStatus {
  configured: boolean;
  connected: boolean;
  message: string;
  target: DatabaseTarget;
  expectedSchema: string;
  currentSchema?: string;
  searchPath?: string;
  ssl?: boolean;
  uuidFunction?: boolean;
  errorType?: DatabaseErrorType | null;
  errorCode?: string | null;
  sslCategory?: SslDiagnosticCategory | null;
  certificateReason?: string | null;
  poolMode: 'session' | 'transaction';
}

function readTarget(): DatabaseTarget {
  const target = (process.env.DB_TARGET || 'LOCAL_DEV').trim().toUpperCase();
  if (target !== 'LOCAL_DEV' && target !== 'CLOUD_STAGING') throw new Error('DB_TARGET must be LOCAL_DEV or CLOUD_STAGING');
  return target;
}

function readSchema(target: DatabaseTarget) {
  const schema = (process.env.DB_SCHEMA || (target === 'CLOUD_STAGING' ? 'line_ccc' : 'public')).trim();
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('DB_SCHEMA must be a lowercase PostgreSQL identifier');
  return schema;
}

function readExtensionSchema(target: DatabaseTarget) {
  const schema = (process.env.DB_EXTENSION_SCHEMA || (target === 'CLOUD_STAGING' ? 'extensions' : 'public')).trim();
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('DB_EXTENSION_SCHEMA must be a lowercase PostgreSQL identifier');
  return schema;
}

function readSslMode(target: DatabaseTarget): DatabaseSslMode {
  const sslMode = (process.env.DB_SSL_MODE || (target === 'CLOUD_STAGING' ? 'require' : 'disable')).trim().toLowerCase();
  if (sslMode !== 'disable' && sslMode !== 'require' && sslMode !== 'verify-full') throw new Error('DB_SSL_MODE must be disable, require, or verify-full');
  if (target === 'CLOUD_STAGING' && sslMode === 'disable') throw new Error('CLOUD_STAGING requires DB_SSL_MODE=require or verify-full');
  return sslMode;
}

function readPositiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function readPoolMode(): 'session' | 'transaction' {
  const mode = (process.env.DB_POOL_MODE || 'session').trim().toLowerCase();
  if (mode !== 'session' && mode !== 'transaction') throw new Error('DB_POOL_MODE must be session or transaction');
  return mode;
}

function readBoolean(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function readSslRejectUnauthorized(target: DatabaseTarget, sslMode: DatabaseSslMode) {
  const configured = process.env.DB_SSL_REJECT_UNAUTHORIZED;
  const value = configured === undefined || configured === '' ? sslMode === 'verify-full' : readBoolean('DB_SSL_REJECT_UNAUTHORIZED', sslMode === 'verify-full');
  if (target === 'CLOUD_STAGING' && !value) throw new Error('CLOUD_STAGING requires certificate verification');
  return value;
}

function readSslCaFile(target: DatabaseTarget, sslMode: DatabaseSslMode) {
  const caFile = process.env.DB_SSL_CA_FILE?.trim();
  if (!caFile || sslMode === 'disable') return undefined;
  try {
    return fs.readFileSync(caFile, 'utf8');
  } catch {
    throw new Error(`${target} SSL CA certificate could not be read`);
  }
}

function resolveConnectionString(target: DatabaseTarget) {
  const specific = target === 'CLOUD_STAGING' ? process.env.CLOUD_STAGING_DATABASE_URL : process.env.LOCAL_DATABASE_URL;
  const connectionString = specific || process.env.DATABASE_URL;
  if (target === 'CLOUD_STAGING' && connectionString) {
    const host = new URL(connectionString).hostname;
    if (['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('CLOUD_STAGING database must not target loopback');
  }
  return connectionString;
}

function getErrorRecord(error: unknown) {
  return typeof error === 'object' && error !== null ? error as Record<string, unknown> : null;
}

function getErrorText(error: unknown) {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const record = getErrorRecord(current);
    if (current instanceof Error && current.message) messages.push(current.message);
    else if (typeof record?.message === 'string') messages.push(record.message);
    current = record?.cause;
  }
  return messages.join(' | ').toLowerCase();
}

function getErrorCode(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const record = getErrorRecord(current);
    const code = record?.code;
    if ((typeof code === 'string' || typeof code === 'number') && /^[a-z0-9_]{2,64}$/i.test(String(code))) return String(code).toUpperCase();
    current = record?.cause;
  }
  return null;
}

export function getDatabaseErrorDiagnostics(error: unknown, fallback: DatabaseErrorType = 'Query'): DatabaseErrorDiagnostics {
  const text = getErrorText(error);
  const trustFailure = /unable_to_verify_leaf_signature|unable to verify|self[- ]signed|certificate has expired|cert_untrusted|unable to get local issuer|ca certificate|certificate file/.test(text);
  const hostnameFailure = /err_tls_cert_altname_invalid|hostname\/ip does not match|does not match.*certificate|certificate.*altname/.test(text);
  const tlsFailure = /err_ssl|tls|ssl|handshake|wrong version|protocol version|secure connection/.test(text);
  const dnsFailure = /enotfound|eai_again|getaddrinfo|dns/.test(text);
  const networkFailure = /econnrefused|etimedout|enetunreach|ehostunreach|econnreset|socket|connection terminated|network/.test(text);
  const authenticationFailure = /28p01|password authentication|authentication failed|invalid authorization/.test(text);
  const schemaFailure = /schema|search_path|gen_random_uuid/.test(text);
  let errorType = fallback;
  if (authenticationFailure) errorType = 'Authentication';
  else if (trustFailure || hostnameFailure || tlsFailure) errorType = 'SSL';
  else if (dnsFailure) errorType = 'DNS';
  else if (networkFailure) errorType = 'Network';
  else if (schemaFailure) errorType = 'Schema';

  let sslCategory: SslDiagnosticCategory | null = null;
  let certificateReason: string | null = null;
  if (trustFailure) {
    sslCategory = 'CertificateTrust';
    certificateReason = 'The server certificate chain is not trusted by the local Node.js CA store.';
  } else if (hostnameFailure) {
    sslCategory = 'HostnameVerification';
    certificateReason = 'The server certificate does not match the configured Session Pooler hostname.';
  } else if (tlsFailure) {
    sslCategory = 'TlsHandshake';
    certificateReason = 'TLS negotiation failed before the PostgreSQL session was established.';
  } else if (networkFailure) {
    sslCategory = 'Network';
  }

  return { errorType, errorCode: getErrorCode(error), sslCategory, certificateReason };
}

export function safeDatabaseErrorMessage(diagnostics: DatabaseErrorDiagnostics) {
  if (diagnostics.errorType === 'SSL') return `SSL ${diagnostics.sslCategory || 'TlsHandshake'} error while running the read-only PostgreSQL connection test.`;
  return `${diagnostics.errorType} error while running the read-only PostgreSQL connection test.`;
}

export function createDatabase() {
  const target = readTarget();
  const schema = readSchema(target);
  const extensionSchema = readExtensionSchema(target);
  const sslMode = readSslMode(target);
  const sslRejectUnauthorized = readSslRejectUnauthorized(target, sslMode);
  const sslCa = readSslCaFile(target, sslMode);
  const poolMode = readPoolMode();
  const connectionString = resolveConnectionString(target);
  const pool = connectionString ? new Pool({
    connectionString,
    max: readPositiveInteger('DB_POOL_MAX', 5),
    idleTimeoutMillis: readPositiveInteger('DB_IDLE_TIMEOUT_MS', 30_000),
    connectionTimeoutMillis: readPositiveInteger('DB_CONNECTION_TIMEOUT_MS', 10_000),
    statement_timeout: readPositiveInteger('DB_STATEMENT_TIMEOUT_MS', 30_000),
    application_name: `line-ccc-${target.toLowerCase()}`,
    options: `-c search_path=${[schema, extensionSchema].filter((value, index, values) => values.indexOf(value) === index).join(',')}`,
    ssl: sslMode === 'disable' ? undefined : { rejectUnauthorized: sslRejectUnauthorized, ...(sslCa ? { ca: sslCa } : {}) }
  }) : null;

  return {
    pool,
    target,
    schema,
    sslMode,
    poolMode,
    async status(): Promise<DatabaseStatus> {
      if (!pool) return { configured: false, connected: false, message: 'DATABASE_URL is not configured', target, expectedSchema: schema, uuidFunction: false, errorType: 'Query', errorCode: null, sslCategory: null, certificateReason: null, poolMode };
      try {
        const result = await pool.query<{ current_schema: string; search_path: string; ssl: boolean; uuid_generator: boolean }>("select current_schema() as current_schema, current_setting('search_path') as search_path, exists (select 1 from pg_stat_ssl where pid=pg_backend_pid() and ssl) as ssl, to_regprocedure('gen_random_uuid()') is not null as uuid_generator");
        const currentSchema = String(result.rows[0]?.current_schema || '');
        const searchPath = String(result.rows[0]?.search_path || '');
        const ssl = Boolean(result.rows[0]?.ssl);
        const uuidGenerator = Boolean(result.rows[0]?.uuid_generator);
        if (currentSchema !== schema) return { configured: true, connected: false, message: 'PostgreSQL connected but the expected schema is not active', target, expectedSchema: schema, currentSchema, searchPath, ssl, uuidFunction: uuidGenerator, errorType: 'Schema', errorCode: null, sslCategory: null, certificateReason: null, poolMode };
        if (sslMode !== 'disable' && !ssl) return { configured: true, connected: false, message: 'PostgreSQL connected without the required SSL session', target, expectedSchema: schema, currentSchema, searchPath, ssl, uuidFunction: uuidGenerator, errorType: 'SSL', errorCode: null, sslCategory: 'TlsHandshake', certificateReason: 'The PostgreSQL session did not report an active SSL connection.', poolMode };
        if (!uuidGenerator) return { configured: true, connected: false, message: 'PostgreSQL connected but gen_random_uuid is unavailable in the configured search path', target, expectedSchema: schema, currentSchema, searchPath, ssl, uuidFunction: uuidGenerator, errorType: 'Schema', errorCode: null, sslCategory: null, certificateReason: null, poolMode };
        return { configured: true, connected: true, message: 'PostgreSQL connection healthy', target, expectedSchema: schema, currentSchema, searchPath, ssl, uuidFunction: uuidGenerator, errorType: null, errorCode: null, sslCategory: null, certificateReason: null, poolMode };
      } catch (error) {
        const diagnostics = getDatabaseErrorDiagnostics(error);
        return { configured: true, connected: false, message: safeDatabaseErrorMessage(diagnostics), target, expectedSchema: schema, errorType: diagnostics.errorType, errorCode: diagnostics.errorCode, sslCategory: diagnostics.sslCategory, certificateReason: diagnostics.certificateReason, poolMode };
      }
    },
    async close() {
      await pool?.end();
    }
  };
}
