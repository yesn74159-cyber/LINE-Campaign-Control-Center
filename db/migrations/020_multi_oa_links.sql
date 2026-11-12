-- A LIFF app belongs to one LINE Login channel, and that channel is linked to one bot, so
-- shareTargetPicker only works for the OA whose channel owns the app. Until now the LIFF id
-- lived only in LINE_LIFF_CHANNEL_ID, which means a second OA could connect but could never
-- share its own card. The id is public (it appears in every share link), so it belongs on the
-- channel row rather than in the secret vault.
--
-- Nullable with no backfill: every existing row keeps using the env value as fallback.
alter table workspace_oa_channels add column if not exists liff_id text;

do $$ begin
  alter table workspace_oa_channels add constraint workspace_oa_channels_liff_id_check
    check (liff_id is null or liff_id ~ '^[0-9]{10}-[A-Za-z0-9]{8,20}$');
exception when duplicate_object then null;
end $$;
