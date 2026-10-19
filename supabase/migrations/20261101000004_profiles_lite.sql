-- Lite mode (K10, AD-36): a per-person setting for slow networks and cheap
-- phones. Null until the person chooses, so a browser asking to save data
-- can turn it on by default while an explicit on or off always wins. Only
-- the person changes it, like the other profile fields: the one column is
-- added to their update grant, which stays additive, so display_name,
-- locale, use_case and onboarded_at remain editable and status does not.

alter table kriya.profiles add column lite_mode boolean;
grant update (lite_mode) on kriya.profiles to authenticated;
