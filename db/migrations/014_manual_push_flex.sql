-- A manual push can now carry a Flex card, not only plain text.
-- message_text keeps the card altText (the line LINE shows in notifications), so the
-- existing NOT NULL rule still holds and history stays readable for both kinds.
alter table manual_push_requests
  add column if not exists message_type text not null default 'text' check (message_type in ('text','flex')),
  add column if not exists flex_json jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'manual_push_flex_document_required') then
    alter table manual_push_requests add constraint manual_push_flex_document_required check (message_type <> 'flex' or flex_json is not null);
  end if;
end $$;
