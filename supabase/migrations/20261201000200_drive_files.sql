-- Files imported from the person's Google Drive (track O, G2;
-- docs/operator/GOOGLE_CONNECTIVITY.md §4.1). `drive_import` stores them in
-- the private bucket like an upload, so they are read by the same
-- extraction pass and counted against the same plan limits. Only the
-- server writes them (privileged); the person's own insert stays 'upload'.

alter table kriya.files drop constraint files_origin_check;
alter table kriya.files add constraint files_origin_check
  check (origin in ('upload', 'generated', 'screenshot', 'email_attachment', 'drive'));
