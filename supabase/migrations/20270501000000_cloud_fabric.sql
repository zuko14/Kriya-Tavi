-- Self-hosted execution fabric (track C extension SH1;
-- docs/cloud-execution/SELF_HOSTED_ARCHITECTURE.md, CD-28…CD-37): machines
-- Kriya operates (kriya-node) as one more workspace provider, 'selfhosted'.
--
-- kriya.exec_nodes holds what the worker last measured on each machine.
-- kriya.exec_leases is the capacity queue below open_workspace_session: one
-- row per time a sandbox is started or resumed on a node. Its id is the
-- fence the node enforces (CD-31): a newer lease on the same sandbox locks
-- every older holder out. kriya.exec_admit grants waiting leases in fair
-- order onto the best-fitting healthy node (CD-32), in one short transaction
-- under one advisory lock; nothing here runs while a sandbox runs.
--
-- Worker-only (privileged, scoped by user id in code); no client role reads
-- or writes either table. No secret, address or token is stored here.

alter table kriya.workspaces drop constraint workspaces_provider_check;
alter table kriya.workspaces add constraint workspaces_provider_check
  check (provider in ('local', 'e2b', 'daytona', 'device', 'selfhosted'));

alter table kriya.workspace_sessions drop constraint workspace_sessions_provider_check;
alter table kriya.workspace_sessions add constraint workspace_sessions_provider_check
  check (provider in ('local', 'e2b', 'daytona', 'device', 'selfhosted'));

/* ───────────────────────────── nodes ────────────────────────────── */

create table kriya.exec_nodes (
  -- selfhosted.nodes names it; part of every sandbox ref on it
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  -- active: takes new sandboxes; draining: only resumes of its own;
  -- retired: removed from selfhosted.nodes
  status text not null default 'active' check (status in ('active', 'draining', 'retired')),
  -- What the node proved at start: gvisor (runsc) or runc (trusted only)
  isolation text check (isolation in ('gvisor', 'runc')),
  -- Allocatable after the node's own reserve, as the node reports it
  cpu_millis integer not null default 0 check (cpu_millis >= 0),
  mem_mb integer not null default 0 check (mem_mb >= 0),
  disk_mb bigint not null default 0 check (disk_mb >= 0),
  -- Measured: free disk and inodes, available memory, PSI some avg10 (%)
  disk_free_mb bigint check (disk_free_mb >= 0),
  inodes_free bigint check (inodes_free >= 0),
  mem_available_mb integer check (mem_available_mb >= 0),
  psi_cpu numeric(6, 2) check (psi_cpu >= 0),
  psi_mem numeric(6, 2) check (psi_mem >= 0),
  psi_io numeric(6, 2) check (psi_io >= 0),
  containers integer check (containers >= 0),
  agent_version text check (char_length(agent_version) <= 64),
  image_digest text check (image_digest ~ '^sha256:[0-9a-f]{64}$'),
  healthy boolean not null default false,
  reason text check (char_length(reason) <= 300),
  stats_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger exec_nodes_touch before update on kriya.exec_nodes
  for each row execute function kriya.touch_updated_at();

/* ───────────────────────────── leases ───────────────────────────── */

create table kriya.exec_leases (
  -- The fence (CD-31): monotonic, never reused
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null references kriya.workspaces (id) on delete cascade,
  generation integer not null check (generation >= 0),
  -- A resume must land where the sandbox's disk is
  pinned_node text references kriya.exec_nodes (id),
  -- The stopped lease a resume takes over (its disk isn't counted twice)
  replaces bigint references kriya.exec_leases (id),
  node_id text references kriya.exec_nodes (id),
  -- sh-<node>-<workspace>-<generation>, set when granted
  ref text check (ref ~ '^sh-[a-z0-9-]{1,32}-[0-9a-f-]{36}-\d{1,9}$'),
  cpu_millis integer not null check (cpu_millis between 1 and 64000),
  mem_mb integer not null check (mem_mb between 64 and 262144),
  disk_mb integer not null check (disk_mb between 0 and 1048576),
  -- Higher goes first among equals (CD-32); 0 for every task today
  priority smallint not null default 0 check (priority between -10 and 10),
  -- waiting → granted → running ⇄ stopped → released;
  -- waiting → expired | cancelled; granted → released
  status text not null default 'waiting' check (status in
    ('waiting', 'granted', 'running', 'stopped', 'released', 'expired', 'cancelled')),
  requested_at timestamptz not null default now(),
  -- The waiter's last exec_admit call; a silent waiter is abandoned
  polled_at timestamptz not null default now(),
  granted_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  reason text check (char_length(reason) <= 200)
);
-- One live sandbox per ref, one queued or live start per workspace
create unique index exec_leases_one_live_ref on kriya.exec_leases (ref)
  where status in ('granted', 'running', 'stopped');
create unique index exec_leases_one_start on kriya.exec_leases (workspace_id)
  where status in ('waiting', 'granted', 'running');
create index exec_leases_waiting_idx on kriya.exec_leases (requested_at)
  where status = 'waiting';
create index exec_leases_node_idx on kriya.exec_leases (node_id, status);
create index exec_leases_user_idx on kriya.exec_leases (user_id, status);
create index exec_leases_pinned_idx on kriya.exec_leases (pinned_node);
create index exec_leases_replaces_idx on kriya.exec_leases (replaces);
create index exec_leases_ended_idx on kriya.exec_leases (ended_at);

/* ─────────────────────────── requesting ─────────────────────────── */

-- A waiting lease for one workspace of this person. Refuses when the queue
-- or the person's share of it is full (backpressure, never a silent drop).
-- An earlier waiter for the same workspace (a crashed attempt) is cancelled.
create function kriya.exec_request(
  p_user uuid, p_workspace uuid, p_generation integer,
  p_cpu integer, p_mem integer, p_disk integer,
  p_pinned text, p_replaces bigint, p_priority integer, p_policy jsonb
) returns bigint language plpgsql set search_path = '' as $$
declare
  v_id bigint;
  v_total integer;
  v_mine integer;
begin
  if not exists (select 1 from kriya.workspaces w where w.id = p_workspace and w.user_id = p_user) then
    raise exception 'execution lease for another person''s workspace';
  end if;
  if p_replaces is not null and not exists (
    select 1 from kriya.exec_leases l
    where l.id = p_replaces and l.workspace_id = p_workspace and l.status = 'stopped'
  ) then
    raise exception 'execution lease replaces a lease it doesn''t own';
  end if;
  perform pg_advisory_xact_lock(hashtext('kriya.exec_leases'));
  update kriya.exec_leases set status = 'expired', ended_at = now(), reason = 'abandoned'
    where status = 'waiting'
      and polled_at < now() - make_interval(secs => coalesce((p_policy->>'abandonSeconds')::int, 30));
  update kriya.exec_leases set status = 'cancelled', ended_at = now(), reason = 'superseded'
    where status = 'waiting' and workspace_id = p_workspace;
  select count(*), count(*) filter (where user_id = p_user) into v_total, v_mine
    from kriya.exec_leases where status = 'waiting';
  if v_total >= coalesce((p_policy->>'maxQueued')::int, 50)
     or v_mine >= coalesce((p_policy->>'maxQueuedPerUser')::int, 2) then
    raise exception 'execution queue is full';
  end if;
  insert into kriya.exec_leases
      (user_id, workspace_id, generation, cpu_millis, mem_mb, disk_mb, pinned_node, replaces, priority)
    values (p_user, p_workspace, p_generation, p_cpu, p_mem, p_disk, p_pinned, p_replaces,
            greatest(-10, least(10, coalesce(p_priority, 0))))
    returning id into v_id;
  return v_id;
end $$;
revoke all on function kriya.exec_request(uuid, uuid, integer, integer, integer, integer, text, bigint, integer, jsonb)
  from public, anon, authenticated;

/* ─────────────────────────── admitting ──────────────────────────── */

-- One row: a version bumped by anything that can change a scheduling
-- decision (a lease freed, a new waiter, a node changed), and the version
-- the last pass saw. Waiters skip the pass when nothing changed (measured:
-- every waiter running its own pass collapsed throughput as queues grew,
-- SELF_HOSTED_BENCHMARK_PLAN §4.2).
create table kriya.exec_state (
  id boolean primary key default true check (id),
  version bigint not null default 0,
  passed bigint not null default -1,
  passed_at timestamptz not null default '-infinity',
  -- The policy the last pass used; an owner's change takes effect at once
  passed_policy jsonb
);
insert into kriya.exec_state default values;

create function kriya.exec_bump() returns trigger
language plpgsql set search_path = '' as $$
begin
  update kriya.exec_state set version = version + 1;
  return null;
end $$;

create trigger exec_leases_bump_insert after insert on kriya.exec_leases
  for each statement execute function kriya.exec_bump();
create trigger exec_leases_bump_update after update on kriya.exec_leases
  for each row when (
    (old.status is distinct from new.status and new.status not in ('granted', 'running'))
    or old.requested_at is distinct from new.requested_at
    or old.priority is distinct from new.priority)
  execute function kriya.exec_bump();
create trigger exec_nodes_bump after insert or update or delete on kriya.exec_nodes
  for each statement execute function kriya.exec_bump();

-- One scheduling pass for everyone, run by whichever waiter polls first
-- after something changed (others find the pass lock taken and return; the
-- pass serves them too). A safety pass runs at least every second, so a
-- waiter that went silent is expired even when nothing else moves.
--
-- Waiters are ranked: starving first (waited past starvationSeconds), then by
-- the person's live leases plus their earlier waiters (fewest first, so every
-- person gets a share before anyone gets two), then priority, then age.
-- Each in turn goes to the healthy node where it fits with the least memory
-- left over (best fit; placement "spread" for comparison). Memory and disk
-- are never overcommitted; CPU by cpuOvercommitPct. Nodes are skipped when
-- their stats are stale, their isolation isn't allowed, or PSI pressure is
-- over the policy's ceiling. A starving waiter that fits nowhere stops the
-- pass (nothing behind it may jump the queue). Node capacity and per-person
-- counts are read once per pass and updated in memory as leases are granted.
-- Returns the caller's lease as it stands afterwards.
create function kriya.exec_admit(p_lease bigint, p_policy jsonb)
returns table (lease_status text, node_id text, ref text)
language plpgsql set search_path = '' as $$
declare
  v_me kriya.exec_leases;
  w record;
  v_over numeric := coalesce((p_policy->>'cpuOvercommitPct')::numeric, 100) / 100;
  v_starve integer := coalesce((p_policy->>'starvationSeconds')::int, 120);
  v_stale integer := coalesce((p_policy->>'staleSeconds')::int, 90);
  v_per_user integer := coalesce((p_policy->>'maxPerUser')::int, 1);
  v_spread boolean := p_policy->>'placement' = 'spread';
  v_isolation text[] := case when p_policy->>'isolation' = 'trusted-runc'
    then array['gvisor', 'runc'] else array['gvisor'] end;
  v_version bigint;
  v_passed bigint;
  v_passed_at timestamptz;
  v_passed_policy jsonb;
  n_id text[];
  n_status text[];
  n_mem bigint[];
  n_cpu bigint[];
  n_disk bigint[];
  n_free bigint[];
  n_room bigint[];
  v_live jsonb;
  v_count integer;
  v_best integer;
  v_left bigint;
  v_best_left bigint;
  v_back bigint;
  v_best_back bigint;
begin
  update kriya.exec_leases set polled_at = now() where id = p_lease and status = 'waiting';
  select * into v_me from kriya.exec_leases where id = p_lease;
  if v_me.id is null then
    raise exception 'unknown execution lease';
  end if;
  if v_me.status <> 'waiting' or coalesce(p_policy->>'admission', 'on') <> 'on'
     or not pg_try_advisory_xact_lock(hashtext('kriya.exec_leases')) then
    return query select v_me.status, v_me.node_id, v_me.ref;
    return;
  end if;
  select s.version, s.passed, s.passed_at, s.passed_policy
    into v_version, v_passed, v_passed_at, v_passed_policy
    from kriya.exec_state s;
  if v_version = v_passed and v_passed_policy = p_policy
     and v_passed_at > clock_timestamp() - interval '1 second' then
    return query select v_me.status, v_me.node_id, v_me.ref;
    return;
  end if;

  update kriya.exec_leases set status = 'expired', ended_at = now(), reason = 'abandoned'
    where status = 'waiting' and id <> p_lease
      and polled_at < now() - make_interval(secs => coalesce((p_policy->>'abandonSeconds')::int, 30));

  -- Eligible nodes and what's left on each
  select array_agg(x.id order by x.id), array_agg(x.status order by x.id),
         array_agg(x.mem_left order by x.id), array_agg(x.cpu_left order by x.id),
         array_agg(x.disk_left order by x.id), array_agg(x.disk_free order by x.id),
         array_agg(x.mem_mb order by x.id)
    into n_id, n_status, n_mem, n_cpu, n_disk, n_free, n_room
  from (
    select n.id, n.status, n.mem_mb,
      n.mem_mb - coalesce(sum(l.mem_mb) filter (where l.status in ('granted', 'running')), 0) as mem_left,
      floor(n.cpu_millis * v_over)
        - coalesce(sum(l.cpu_millis) filter (where l.status in ('granted', 'running')), 0) as cpu_left,
      n.disk_mb - coalesce(sum(l.disk_mb) filter (where l.status in ('granted', 'running', 'stopped')), 0) as disk_left,
      coalesce(n.disk_free_mb, 0) as disk_free
    from kriya.exec_nodes n
    left join kriya.exec_leases l on l.node_id = n.id
    where n.status in ('active', 'draining')
      and n.healthy
      and n.stats_at > now() - make_interval(secs => v_stale)
      and n.isolation = any (v_isolation)
      and coalesce(n.psi_cpu, 0) <= coalesce((p_policy->>'psiCpuMax')::numeric, 60)
      and coalesce(n.psi_mem, 0) <= coalesce((p_policy->>'psiMemMax')::numeric, 10)
      and coalesce(n.psi_io, 0) <= coalesce((p_policy->>'psiIoMax')::numeric, 40)
    group by n.id
  ) x;

  select coalesce(jsonb_object_agg(a.user_id::text, a.c), '{}'::jsonb) into v_live
    from (select l.user_id, count(*) as c from kriya.exec_leases l
          where l.status in ('granted', 'running') group by l.user_id) a;

  for w in
    select l.*, l.requested_at < now() - make_interval(secs => v_starve) as starving
    from kriya.exec_leases l
    left join (select a.user_id, count(*) as c from kriya.exec_leases a
               where a.status in ('granted', 'running') group by a.user_id) live
      on live.user_id = l.user_id
    where l.status = 'waiting'
    order by
      (l.requested_at < now() - make_interval(secs => v_starve)) desc,
      coalesce(live.c, 0) + row_number() over (partition by l.user_id order by l.requested_at, l.id),
      l.priority desc, l.requested_at, l.id
  loop
    v_count := coalesce((v_live->>w.user_id::text)::int, 0);
    if v_count >= v_per_user then
      continue;
    end if;
    v_best := null;
    for i in 1 .. coalesce(array_length(n_id, 1), 0) loop
      continue when n_status[i] = 'draining' and n_id[i] is distinct from w.pinned_node;
      continue when w.pinned_node is not null and n_id[i] <> w.pinned_node;
      -- A resume takes over its stopped lease's disk; a new sandbox needs
      -- its quota free on the node itself
      v_back := 0;
      if w.replaces is not null then
        select coalesce(sum(l.disk_mb), 0) into v_back from kriya.exec_leases l
          where l.id = w.replaces and l.node_id = n_id[i] and l.status = 'stopped';
      elsif n_free[i] < w.disk_mb then
        continue;
      end if;
      if n_mem[i] >= w.mem_mb and n_cpu[i] >= w.cpu_millis and n_disk[i] + v_back >= w.disk_mb then
        v_left := case when v_spread then -(n_mem[i] - w.mem_mb) else n_mem[i] - w.mem_mb end;
        if v_best is null or v_left < v_best_left then
          v_best := i;
          v_best_left := v_left;
          v_best_back := v_back;
        end if;
      end if;
    end loop;

    if v_best is not null then
      if w.replaces is not null then
        update kriya.exec_leases set status = 'released', ended_at = now(), reason = 'replaced'
          where id = w.replaces and status = 'stopped';
      end if;
      update kriya.exec_leases set
        status = 'granted', node_id = n_id[v_best], granted_at = now(),
        ref = 'sh-' || n_id[v_best] || '-' || w.workspace_id || '-' || w.generation
        where id = w.id;
      n_mem[v_best] := n_mem[v_best] - w.mem_mb;
      n_cpu[v_best] := n_cpu[v_best] - w.cpu_millis;
      n_disk[v_best] := n_disk[v_best] + v_best_back - w.disk_mb;
      if w.replaces is null then
        n_free[v_best] := n_free[v_best] - w.disk_mb;
      end if;
      v_live := jsonb_set(v_live, array[w.user_id::text], to_jsonb(v_count + 1));
    elsif w.starving then
      -- Unpinned, it could take any node: nothing behind it may jump the
      -- queue. Pinned, it holds only its own node (and none when that node
      -- isn't eligible), so one sick node never stalls the others
      -- (A waiter larger than every node's whole memory never fits: skipped.)
      if w.pinned_node is null then
        if exists (select 1 from unnest(n_room) r where r >= w.mem_mb) then
          exit;
        end if;
        continue;
      end if;
      v_best := array_position(n_id, w.pinned_node);
      if v_best is not null then
        n_mem[v_best] := -1;
      end if;
    end if;
  end loop;

  update kriya.exec_state
    set passed = v_version, passed_at = clock_timestamp(), passed_policy = p_policy;
  return query select l.status, l.node_id, l.ref from kriya.exec_leases l where l.id = p_lease;
end $$;
revoke all on function kriya.exec_admit(bigint, jsonb) from public, anon, authenticated;

/* ─────────────────────────── observing ──────────────────────────── */

-- For the owner page and alerts (SELF_HOSTED_OPERATIONS_RUNBOOK §6): queue
-- depth, oldest wait, grants and outcomes of the last hour, wait
-- percentiles, and each node's reservations against its capacity.
create function kriya.exec_metrics() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'waiting', (select count(*) from kriya.exec_leases where status = 'waiting'),
    'oldestWaitSeconds', (select coalesce(extract(epoch from now() - min(requested_at)), 0)::int
                          from kriya.exec_leases where status = 'waiting'),
    'lastHour', (select jsonb_build_object(
        'granted', count(*) filter (where granted_at is not null),
        'expired', count(*) filter (where status = 'expired'),
        'cancelled', count(*) filter (where status = 'cancelled'),
        'startFailed', count(*) filter (where reason in ('start_failed', 'start_timeout')),
        'waitP50', percentile_cont(0.5) within group (order by extract(epoch from granted_at - requested_at))
                   filter (where granted_at is not null),
        'waitP95', percentile_cont(0.95) within group (order by extract(epoch from granted_at - requested_at))
                   filter (where granted_at is not null),
        'waitP99', percentile_cont(0.99) within group (order by extract(epoch from granted_at - requested_at))
                   filter (where granted_at is not null))
      from kriya.exec_leases where requested_at > now() - interval '1 hour'),
    'nodes', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', n.id, 'status', n.status, 'healthy', n.healthy, 'isolation', n.isolation,
        'statsAgeSeconds', extract(epoch from now() - n.stats_at)::int,
        'cpuMillis', n.cpu_millis, 'memMb', n.mem_mb, 'diskMb', n.disk_mb,
        'cpuReserved', (select coalesce(sum(cpu_millis), 0) from kriya.exec_leases l
                        where l.node_id = n.id and l.status in ('granted', 'running')),
        'memReserved', (select coalesce(sum(mem_mb), 0) from kriya.exec_leases l
                        where l.node_id = n.id and l.status in ('granted', 'running')),
        'diskReserved', (select coalesce(sum(disk_mb), 0) from kriya.exec_leases l
                         where l.node_id = n.id and l.status in ('granted', 'running', 'stopped')),
        'psiCpu', n.psi_cpu, 'psiMem', n.psi_mem, 'psiIo', n.psi_io,
        'diskFreeMb', n.disk_free_mb, 'reason', n.reason) order by n.id), '[]'::jsonb)
      from kriya.exec_nodes n where n.status <> 'retired')
  )
$$;
revoke all on function kriya.exec_metrics() from public, anon, authenticated;

/* ───────────────────────────── access ───────────────────────────── */

alter table kriya.exec_nodes enable row level security;
alter table kriya.exec_leases enable row level security;
alter table kriya.exec_state enable row level security;
create policy no_access on kriya.exec_nodes for all to anon, authenticated
  using (false) with check (false);
create policy no_access on kriya.exec_leases for all to anon, authenticated
  using (false) with check (false);
create policy no_access on kriya.exec_state for all to anon, authenticated
  using (false) with check (false);
