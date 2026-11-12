import type { Pool } from 'pg';

/**
 * Which OA tier the runtime may touch. Every OA-facing statement used to spell out
 * environment='STAGING' inline; one constant keeps a future tier change to a single edit.
 * The value is interpolated, never a query parameter, because adding a $n to the
 * transactional statements would renumber their existing placeholders.
 */
export const OA_TIER = 'STAGING' as const;
export function oaTierSql(alias?: string) {
  return `${alias ? `${alias}.` : ''}environment='${OA_TIER}'`;
}
export const OA_TIER_SQL = oaTierSql('oa');
export const OA_REQUIRED_BLOCKER = 'A staging OA must be selected';

export type OaCandidate = { id: string; displayName: string; basicId: string };
export type OaResolution =
  | { status: 'RESOLVED'; oa: OaCandidate }
  | { status: 'NONE' | 'AMBIGUOUS' | 'NOT_FOUND'; candidates: OaCandidate[] };

/**
 * Turns "which OA?" into an explicit answer instead of the first enabled row. Callers that
 * cannot proceed without one show the candidates to the operator rather than guessing.
 * `oaId` also accepts the public basic id, which is what a share link carries.
 */
export async function resolveOa(
  db: Pick<Pool, 'query'>,
  input: { workspaceId: string; oaId?: string | null }
): Promise<OaResolution> {
  const result = await db.query<OaCandidate>(
    'select oa.id, oa.display_name as "displayName", oa.basic_id as "basicId" from oa_integrations oa ' +
    `where oa.workspace_id=$1 and ${OA_TIER_SQL} and oa.enabled=true order by oa.created_at`,
    [input.workspaceId]
  );
  const candidates = result.rows;
  const requested = (input.oaId || '').trim();
  if (requested) {
    const match = candidates.find((item) => item.id === requested || item.basicId === requested);
    return match ? { status: 'RESOLVED', oa: match } : { status: 'NOT_FOUND', candidates };
  }
  if (candidates.length === 0) return { status: 'NONE', candidates };
  if (candidates.length > 1) return { status: 'AMBIGUOUS', candidates };
  return { status: 'RESOLVED', oa: candidates[0]! };
}

export type ShareOaCandidate = OaCandidate & { liffId: string | null };
export type ShareOaResolution =
  | { status: 'RESOLVED'; oa: ShareOaCandidate }
  | { status: 'NONE' | 'AMBIGUOUS' | 'NOT_FOUND'; candidates: ShareOaCandidate[] };

/**
 * The public `/share` landing page has no session, so it cannot scope by workspace: the
 * customer arrived through a link for one OA and that link names it. The stored LIFF id
 * comes along because a LIFF id is per-OA, while the env value is a single fallback.
 */
export async function resolveShareOa(db: Pick<Pool, 'query'>, requested?: string | null): Promise<ShareOaResolution> {
  const result = await db.query<ShareOaCandidate>(
    'select oa.id, oa.display_name as "displayName", oa.basic_id as "basicId", c.liff_id as "liffId" from oa_integrations oa ' +
    'left join workspace_oa_channels c on c.workspace_id=oa.workspace_id and c.oa_integration_id=oa.id ' +
    `where oa.enabled=true and ${OA_TIER_SQL} order by oa.created_at`
  );
  const candidates = result.rows;
  const wanted = (requested || '').trim();
  if (wanted) {
    const match = candidates.find((item) => item.id === wanted || item.basicId === wanted);
    return match ? { status: 'RESOLVED', oa: match } : { status: 'NOT_FOUND', candidates };
  }
  if (candidates.length === 0) return { status: 'NONE', candidates };
  if (candidates.length > 1) return { status: 'AMBIGUOUS', candidates };
  return { status: 'RESOLVED', oa: candidates[0]! };
}
