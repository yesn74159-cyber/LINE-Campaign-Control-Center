import fs from 'node:fs';
import net from 'node:net';
import tls, { checkServerIdentity, type PeerCertificate, type TLSSocket } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { getDatabaseErrorDiagnostics, type DatabaseErrorType, type SslDiagnosticCategory } from './db.js';

type CertificateCheckResult = {
  schemaVersion: 1;
  checker: 'supabase-ssl-certificate';
  ok: boolean;
  endpointHost: string | null;
  port: number;
  caConfigured: boolean;
  caIsCertificateAuthority: boolean;
  caSubject: string | null;
  caIssuer: string | null;
  caValidFrom: string | null;
  caValidTo: string | null;
  caExpired: boolean | null;
  peerAuthorized: boolean | null;
  hostnameVerified: boolean | null;
  chainLength: number | null;
  errorType: DatabaseErrorType | null;
  errorCode: string | null;
  sslCategory: SslDiagnosticCategory | null;
  certificateReason: string | null;
  message: string;
};

const poolerPort = 5432;

function safeCertificateDate(value: string | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function getCertificateChainLength(certificate: PeerCertificate) {
  let current: PeerCertificate | undefined = certificate;
  const seen = new Set<PeerCertificate>();
  let length = 0;
  while (current && !seen.has(current) && length < 32) {
    seen.add(current);
    length += 1;
    current = (current as PeerCertificate & { issuerCertificate?: PeerCertificate }).issuerCertificate;
  }
  return length || null;
}

function safeTlsError(error: unknown, fallbackMessage: string) {
  const diagnostics = getDatabaseErrorDiagnostics(error, 'SSL');
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : null;
  const code = typeof record?.code === 'string' ? record.code.toUpperCase() : diagnostics.errorCode;
  const certificateFileFailure = code?.startsWith('CA_CERTIFICATE_') || code === 'ENOENT' || code === 'EACCES';
  if (certificateFileFailure) {
    return {
      errorType: 'SSL' as const,
      errorCode: code,
      sslCategory: 'CertificateTrust' as const,
      certificateReason: 'The configured CA file is missing, invalid, expired, or is not a certificate authority.',
      message: fallbackMessage
    };
  }
  if (diagnostics.sslCategory === 'CertificateTrust') {
    return {
      errorType: 'SSL' as const,
      errorCode: code,
      sslCategory: 'CertificateTrust' as const,
      certificateReason: 'The supplied CA did not validate the Session Pooler certificate. Possible causes are a wrong CA file or TLS interception; no unknown CA was trusted.',
      message: fallbackMessage
    };
  }
  return {
    errorType: diagnostics.errorType,
    errorCode: diagnostics.errorCode,
    sslCategory: diagnostics.sslCategory,
    certificateReason: diagnostics.certificateReason,
    message: fallbackMessage
  };
}

function emptyResult(endpointHost: string | null): CertificateCheckResult {
  return {
    schemaVersion: 1,
    checker: 'supabase-ssl-certificate',
    ok: false,
    endpointHost,
    port: poolerPort,
    caConfigured: false,
    caIsCertificateAuthority: false,
    caSubject: null,
    caIssuer: null,
    caValidFrom: null,
    caValidTo: null,
    caExpired: null,
    peerAuthorized: null,
    hostnameVerified: null,
    chainLength: null,
    errorType: 'SSL',
    errorCode: null,
    sslCategory: 'CertificateTrust',
    certificateReason: 'A trusted Supabase CA certificate is required before the database password is requested.',
    message: 'SSL certificate preflight failed before the read-only database connection test.'
  };
}

function readCaCertificate(caFile: string) {
  const caBytes = fs.readFileSync(caFile);
  const caPem = caBytes.toString('utf8');
  const pemBlocks = [...caPem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)].map((match) => match[0]);
  const caMaterial: string | Buffer = pemBlocks.length > 0 ? caPem : caBytes;
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(pemBlocks.length > 0 ? pemBlocks[0] : caBytes);
  } catch {
    throw Object.assign(new Error('CA certificate was not a valid PEM or DER certificate'), { code: 'CA_CERTIFICATE_INVALID' });
  }
  const now = Date.now();
  const validFromMs = Date.parse(certificate.validFrom);
  const validToMs = Date.parse(certificate.validTo);
  const expired = !Number.isFinite(validFromMs) || !Number.isFinite(validToMs) || now < validFromMs || now > validToMs;
  if (!certificate.ca) throw Object.assign(new Error('The configured certificate is not a CA certificate'), { code: 'CA_CERTIFICATE_NOT_CA' });
  if (expired) throw Object.assign(new Error('The configured CA certificate is outside its validity period'), { code: 'CA_CERTIFICATE_EXPIRED' });
  return {
    caMaterial,
    certificate,
    caConfigured: true,
    caIsCertificateAuthority: true,
    caSubject: certificate.subject,
    caIssuer: certificate.issuer,
    caValidFrom: safeCertificateDate(certificate.validFrom),
    caValidTo: safeCertificateDate(certificate.validTo),
    caExpired: false
  };
}

function connectAndVerify(poolerHost: string, caMaterial: string | Buffer) {
  return new Promise<{ peer: PeerCertificate; tlsSocket: TLSSocket }>((resolve, reject) => {
    const plainSocket = net.createConnection({ host: poolerHost, port: poolerPort });
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      plainSocket.destroy();
      reject(error);
    };

    plainSocket.setTimeout(10_000, () => fail(Object.assign(new Error('Session Pooler TLS preflight timed out'), { code: 'ETIMEDOUT' })));
    plainSocket.once('error', fail);
    plainSocket.once('connect', () => {
      const sslRequest = Buffer.alloc(8);
      sslRequest.writeInt32BE(8, 0);
      sslRequest.writeInt32BE(80877103, 4);
      plainSocket.write(sslRequest);
    });
    plainSocket.once('data', (response) => {
      if (response[0] !== 0x53) {
        fail(Object.assign(new Error('Session Pooler did not accept PostgreSQL TLS negotiation'), { code: 'TLS_NOT_ACCEPTED' }));
        return;
      }
      plainSocket.pause();
      const tlsSocket = tls.connect({
        socket: plainSocket,
        servername: poolerHost,
        ca: caMaterial,
        rejectUnauthorized: true
      });
      tlsSocket.once('error', fail);
      tlsSocket.once('secureConnect', () => {
        if (settled) return;
        settled = true;
        const peer = tlsSocket.getPeerCertificate(true);
        resolve({ peer, tlsSocket });
      });
    });
  });
}

export async function runSslCertificateCheck(poolerHost: string, caFile: string): Promise<CertificateCheckResult> {
  let result = emptyResult(poolerHost);
  try {
    if (!poolerHost || !/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/i.test(poolerHost)) {
      throw Object.assign(new Error('The configured endpoint is not a Supabase Session Pooler hostname'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    }
    const ca = readCaCertificate(caFile);
    result = {
      ...result,
      caConfigured: ca.caConfigured,
      caIsCertificateAuthority: ca.caIsCertificateAuthority,
      caSubject: ca.caSubject,
      caIssuer: ca.caIssuer,
      caValidFrom: ca.caValidFrom,
      caValidTo: ca.caValidTo,
      caExpired: ca.caExpired
    };
    const { peer, tlsSocket } = await connectAndVerify(poolerHost, ca.caMaterial);
    const hostnameError = checkServerIdentity(poolerHost, peer);
    const hostnameVerified = !hostnameError;
    const peerAuthorized = tlsSocket.authorized;
    const authorizationError = tlsSocket.authorizationError;
    tlsSocket.end();
    if (!peerAuthorized || authorizationError || hostnameError) {
      const verificationError: unknown = hostnameError || {
        code: authorizationError || 'CERTIFICATE_VERIFY_FAILED',
        message: authorizationError || 'TLS certificate verification failed'
      };
      const diagnostics = safeTlsError(verificationError, 'The Supabase Session Pooler certificate could not be verified with the configured CA.');
      return { ...result, peerAuthorized, hostnameVerified, chainLength: getCertificateChainLength(peer), ...diagnostics };
    }
    return {
      ...result,
      ok: true,
      peerAuthorized: true,
      hostnameVerified: true,
      chainLength: getCertificateChainLength(peer),
      errorType: null,
      errorCode: null,
      sslCategory: null,
      certificateReason: null,
      message: 'Supabase Session Pooler certificate chain and hostname verified.'
    };
  } catch (error) {
    const diagnostics = safeTlsError(error, 'The Supabase Session Pooler certificate preflight could not be completed.');
    return { ...result, ...diagnostics };
  }
}

const poolerHost = process.env.SUPABASE_POOLER_HOST?.trim() || '';
const caFile = process.env.DB_SSL_CA_FILE?.trim() || '';
const certificateResult = caFile
  ? await runSslCertificateCheck(poolerHost, caFile)
  : { ...emptyResult(poolerHost || null), message: 'DB_SSL_CA_FILE is required for verified Supabase Session Pooler TLS.' };

console.log(JSON.stringify(certificateResult));
if (!certificateResult.ok) process.exitCode = 1;
