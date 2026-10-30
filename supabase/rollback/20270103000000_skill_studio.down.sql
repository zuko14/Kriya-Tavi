-- Reverses 20270103000000_skill_studio.sql. Every person's Skill Studio
-- skills are deleted and taken off their agents; the design-cost rows go.
-- Turn next.skillStudio off first.
--
--   psql "$MIGRATION_DATABASE_URL" -f supabase/rollback/20270103000000_skill_studio.down.sql

update kriya.agents
set skills = jsonb_set(
  skills, '{on}',
  coalesce(
    (select jsonb_agg(s) from jsonb_array_elements_text(skills -> 'on') s
     where s not like 'my-%'),
    '[]'::jsonb
  )
)
where skills is not null and skills -> 'on' @? '$[*] ? (@ like_regex "^my-")';

drop table if exists kriya.user_skills;

delete from kriya.resource_usage where kind = 'skill_design';
alter table kriya.resource_usage drop constraint resource_usage_kind_check;
alter table kriya.resource_usage add constraint resource_usage_kind_check check (kind in (
  'browser_seconds', 'pdf_render', 'storage_bytes', 'embedding_tokens',
  'maintenance_model', 'web_fetch'
));

delete from supabase_migrations.schema_migrations where version = '20270103000000';
