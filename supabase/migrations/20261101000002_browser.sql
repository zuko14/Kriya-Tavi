-- Agent browser (phase A4, BROWSER_AND_LOGIN_PROFILES.md §10, DATA_MODEL
-- §2.4): one row per kriya-browser session, and the plan's browser minutes
-- enforced here when a session opens (invariant 7). Time is metered in
-- kriya.resource_usage (kind browser_seconds, A1) when the session closes.
-- Only the worker writes; the person reads their own rows.

create table kriya.browser_sessions (
  -- The kriya-browser session id
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid references kriya.tasks (id) on delete set null,
  -- References kriya.login_profiles once A6 creates it
  login_profile_id uuid,
  status text not null default 'open'
    check (status in ('open', 'paused', 'closed', 'failed')),
  provider text not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  seconds integer check (seconds >= 0)
);
create index browser_sessions_user_idx on kriya.browser_sessions (user_id, opened_at);

alter table kriya.browser_sessions enable row level security;
create policy read_own on kriya.browser_sessions for select to authenticated
  using (user_id = (select auth.uid()));
grant select on kriya.browser_sessions to authenticated;

-- Records a session for a task, or refuses when this month's (IST) metered
-- browser seconds have reached the plan's browser_minutes. Called by the
-- worker only. ponytail: time of sessions still open isn't counted until
-- they close (at most 15 minutes each); count open sessions if plans get tight.
create function kriya.open_browser_session(p_id uuid, p_task uuid, p_provider text)
returns void language plpgsql as $$
declare
  v_user uuid;
  v_minutes integer;
  v_used bigint;
begin
  select t.user_id, p.browser_minutes into v_user, v_minutes
    from kriya.tasks t join kriya.plans p on p.id = t.plan_id
    where t.id = p_task;
  if v_user is null then
    raise exception 'browser session for an unknown task';
  end if;
  select coalesce(sum(quantity), 0) into v_used
    from kriya.resource_usage
    where user_id = v_user and kind = 'browser_seconds'
      and created_at >= (date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata');
  if v_used >= v_minutes::bigint * 60 then
    raise exception 'browser minutes used up for this month';
  end if;
  insert into kriya.browser_sessions (id, user_id, task_id, provider)
    values (p_id, v_user, p_task, p_provider);
end
$$;
revoke all on function kriya.open_browser_session(uuid, uuid, text) from public, anon, authenticated;
