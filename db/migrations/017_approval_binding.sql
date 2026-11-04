-- Approval must name the revision it approved. Until now campaign_controls held a
-- campaign-level APPROVED flag while addJob froze the *latest* revision, so saving a new
-- card after approval scheduled content nobody had reviewed.
--
-- The hash is computed in SQL so approve and readiness compare exactly the same value:
-- jsonb's text form is already deterministic (keys sorted, spacing normalised), so there
-- is no JavaScript canonicalisation to keep in sync.

alter table campaign_controls
  add column if not exists approved_revision_id uuid references campaign_revisions(id) on delete set null,
  add column if not exists approved_content_hash text;

-- A campaign approved before this migration was approved against the revision that was
-- latest at that moment, which is also the only revision its existing jobs could freeze.
update campaign_controls cc
set approved_revision_id = r.id,
    approved_content_hash = md5(r.flex_json::text || '|' || c.name || '|' || c.title || '|' || c.image || '|' || c.cta)
from campaigns c
join lateral (
  select id, flex_json from campaign_revisions where campaign_id = c.id order by revision desc limit 1
) r on true
where cc.campaign_id = c.id
  and cc.approval_status = 'APPROVED'
  and cc.approved_revision_id is null;

create index if not exists campaign_controls_approved_revision_idx
  on campaign_controls(approved_revision_id);
