# Kriya Tavi — Self-Hosted Adaptive Execution Fabric

**Document type:** Architecture investigation, implementation brief, and production-readiness specification  
**Status:** Proposed engineering programme — must be reconciled with the current repository before implementation  
**Primary objective:** Deliver reliable, secure, cost-efficient agent task execution on modest self-hosted infrastructure, while preserving provider independence and the existing Kriya Cloud / Harness architecture.

---

## 0. Executive intent

Kriya Tavi should be able to execute agent tasks using a cost-efficient self-hosted execution fleet, initially evaluating a small Hostinger VPS such as KVM 2 or KVM 4, without assuming that a single VPS can safely or reliably execute an unlimited number of workloads.

The engineering objective is **maximum verified successful work per unit of compute and money**, not maximum process count, maximum agent count, or maximum infrastructure spend.

Build an execution platform in which:

- A large number of logical agent sessions can remain active, waiting, coordinating, or reasoning without each owning a continuously running machine.
- CPU- and memory-intensive operations are admitted only when a scheduler has sufficient measured capacity.
- The execution environment is isolated, resource-limited, monitored, recoverable, and tenant-aware.
- Task state survives worker restarts and node interruptions.
- Customers receive fair access and one tenant cannot exhaust shared resources.
- Provider-specific execution infrastructure is replaceable behind a stable Kriya interface.
- Existing E2B and Daytona support is preserved unless repository evidence demonstrates a safe reason to change it.
- Self-hosted execution is an additional provider, not a rewrite of the existing Kriya Harness or Cloud control plane.
- The system can begin on one modest node and grow horizontally when measured evidence justifies it.

**Do not promise 100% availability or reliability.** No non-trivial distributed system can guarantee that. Define measurable SLOs, error budgets, recovery objectives, and explicit operating limits. A single VPS is a single point of failure, regardless of how sophisticated its scheduler is. Design for recovery and graceful degradation, and state clearly what one node cannot guarantee.

The architecture, algorithms, tools, data structures, and technology choices in this document are starting hypotheses, not mandatory prescriptions. You are the principal architect and implementation owner. You must research and compare current alternatives, inspect the existing code, and choose better approaches whenever the evidence supports them.

---

## 1. Your role and authority

Act as a combined:

- Principal distributed-systems architect
- Senior platform and runtime engineer
- Linux/container security engineer
- SRE and reliability engineer
- Performance and cost engineer
- Database and queueing-systems engineer
- Test, chaos, and benchmark engineer
- Release engineer

You are authorised to make architecture and implementation decisions **inside the existing repository**, provided that you:

1. First inspect the actual codebase and document the current state.
2. Explain the trade-offs and evidence for material decisions.
3. Preserve existing working functionality and backward compatibility.
4. Prefer the smallest reliable design over unnecessary infrastructure complexity.
5. Add tests and operational documentation with every meaningful feature.
6. Keep production-impacting changes, external spending, account creation, provider provisioning, secret rotation, destructive migrations, and production deployments behind explicit owner approval.
7. Never fake test evidence, claim a phase complete without evidence, or silently weaken a security control to make a test pass.

You may reject, replace, or improve any recommendation in this document. Do not follow a proposed technology merely because it appears here. Select based on measured requirements, compatibility, security, cost, operating burden, and the state of the repository.

---

## 2. Repository-first discovery — mandatory before coding

Do not assume this document accurately describes the current branch. The repository is the source of truth.

### 2.1 Inspect the project

Read, at minimum, and follow any repository-specific instructions:

- `AGENTS.md` and all nested agent instruction files
- `README.md`
- `status.md` and relevant status ledgers
- `package.json` and lockfiles
- Cloud execution architecture, implementation plans, operations runbooks, provider docs, evaluation plans, and test plans
- Harness architecture, implementation plan, distribution/release docs, and benchmark docs
- Existing provider adapters and workspace interfaces
- Existing worker, queue, task lifecycle, checkpoint, janitor, artifact, and publish implementations
- Database schema, migrations, RLS policies, and Supabase integration
- Render service definitions and deployment configuration
- Existing tests, CI workflows, security checks, and readiness scripts

Find the current implementations of concepts such as `TaskWorkspace`, `workspace_open`, `workspace_run`, `workspace_read`, `workspace_write`, `workspace_changes`, `workspace_publish`, provider configuration, runner image configuration, worker lifecycle, and any existing queue/scheduler. Names may have changed; search the repository rather than assuming exact names.

### 2.2 Establish a clean baseline

Record:

- Current branch and commit
- Working-tree state, including untracked files
- Existing user changes that must be preserved
- Existing CI state and known failures
- Current typecheck, lint, format, unit, integration, build, migration, and readiness results
- Existing Cloud, Harness, and Rooms release gates that may be affected
- Current production/staging flags and defaults, without printing secret values
- Existing E2B/Daytona adapter maturity: implementation, contract tests, live tests, limitations
- Current Render and Supabase assumptions, clearly separating repository configuration from actual deployed configuration

Do not reset, clean, stash, overwrite, or discard pre-existing changes. Do not switch branches or perform Git operations that could lose user work. Do not print `.env` values, API keys, tokens, private customer data, or credentials.

### 2.3 Produce a discovery report before implementation

Create or update a document such as:

`docs/cloud-execution/SELF_HOSTED_ARCHITECTURE_AUDIT.md`

Include:

- Current architecture and data flow
- Components that can be reused unchanged
- Components that need extension
- Duplicate or overlapping mechanisms to avoid
- Existing security and reliability gaps
- Existing test coverage and unverified claims
- Constraints imposed by Render, Supabase, Hostinger, and the current runner image
- Recommended target architecture and at least two credible alternatives
- A phased implementation plan with risks and acceptance criteria

If a key fact cannot be verified from code or an authoritative source, label it `UNKNOWN` and state how to verify it. Do not turn assumptions into facts.

---

## 3. Product and workload model

### 3.1 Distinguish logical concurrency from execution concurrency

Do not equate 100 active agents with 100 simultaneously running Linux processes or 100 simultaneous CPU-intensive sandbox jobs.

Model at least these distinct states:

- Agent/session exists and is idle
- Agent is waiting for an LLM response
- Agent is waiting for user approval
- Agent is waiting on an external API or database
- Agent has runnable work queued
- Task has been admitted and reserved resources
- Task is actively executing code
- Task is checkpointing or persisting artifacts
- Task is retrying or recovering
- Task is completed, cancelled, expired, or dead-lettered

Agent reasoning and orchestration should generally be event-driven and persisted. Execution slots should be occupied only while an operation needs the execution environment. Do not keep a container or process alive merely because a logical agent session remains open.

### 3.2 Define workload classes using evidence

Start by measuring and classifying real Kriya task workloads. Candidate classes include:

- **Interactive/light:** repository metadata, directory listing, small file reads, short scripts, small API/tool operations
- **Standard:** code inspection, moderate scripts, targeted tests, normal dependency operations
- **Heavy:** dependency installation, builds, large test suites, large repository operations, memory-intensive analysis
- **Long-running/background:** batch tasks that can tolerate queueing and lower priority
- **Untrusted/high-risk:** arbitrary user-supplied code or workloads requiring a stronger isolation boundary

Resource values in this document are not fixed truth. Determine CPU, RAM, disk, process, I/O, network, and wall-clock needs from measurements. Avoid allocating large fixed reservations to every task.

### 3.3 Establish a representative workload suite

Build a reproducible benchmark suite from real or safely synthetic Kriya tasks. It should cover:

- Small and large repositories
- Node/TypeScript and Python projects
- Dependency install/cache hit and miss
- File inspection and edits
- Unit tests and builds
- Long-running commands and cancellation
- Network access allowed and denied cases
- Memory pressure and CPU saturation
- Concurrent tenants and task priorities
- Worker interruption and node restart
- Large logs and output truncation
- Checkpoint, resume, and cleanup

Use anonymised or synthetic data. Never benchmark with real customer secrets or production customer repositories without permission.

---

## 4. Target architecture — evaluate and refine

The proposed direction is a **shared control plane plus a separately managed execution plane**.

### 4.1 Control plane

The control plane should own:

- Authentication and tenant authorization
- Agent and task lifecycle
- Durable task state
- Scheduling and admission control
- Resource reservations
- Provider selection
- Workspace lifecycle requests
- Checkpoint metadata and artifact references
- Approval and publish policy
- Usage metering, quotas, and billing events
- Audit trail and operational metrics

Keep this integrated with the existing Kriya backend/Harness and existing Render/Supabase services where appropriate. Do not create a second control plane if one already exists and is sound.

### 4.2 Execution plane

The execution plane should contain:

- One or more registered execution nodes
- A small node agent/worker supervisor
- A task worker pool
- A container/runtime adapter
- Per-task isolated environments
- Local ephemeral task storage
- A controlled egress path
- Metrics and health reporting
- A cleanup/garbage-collection service

A Hostinger KVM 2 or KVM 4 may be used for the first staging experiment, but verify actual CPU, memory, storage, kernel, cgroup, namespace, AppArmor/SELinux, seccomp, networking, and virtualization capabilities. Do not assume the VPS has nested KVM or that it can run Firecracker. Test capabilities directly and consult current Hostinger documentation. If KVM access is unavailable, do not try to bypass the provider restriction.

### 4.3 Provider independence

Preserve a common Kriya execution contract, extending the existing interface rather than creating a parallel API. Existing E2B and Daytona adapters should continue to work if they are already integrated.

Add a self-hosted adapter/provider only after mapping the exact existing interface and lifecycle semantics. Provider-specific details must remain behind adapters.

The common lifecycle should cover the existing repository's actual requirements, which may include:

- Create/open workspace
- Import or mount a pinned repository revision
- Execute a command with timeout, cancellation, environment, and output limits
- Read/list/search files
- Write/edit/patch files
- Report status and resource use
- Capture a checkpoint or durable state
- Resume/recover where supported
- Collect changes/artifacts
- Stop/destroy workspace
- Publish approved changes through the trusted control plane

Do not expose provider credentials or privileged control-plane operations to the sandbox.

### 4.4 Keep orchestration out of the execution sandbox

The sandbox should execute the requested task, not become the trusted authority for tenant identity, billing, approvals, connector credentials, or publication decisions.

Use a narrow, authenticated worker protocol. The sandbox must not be able to forge task ownership, raise its own resource limits, choose another tenant's workspace, bypass approvals, or request arbitrary secrets.

---

## 5. Scheduler, queue, and admission-control engineering

This is a core differentiator. Design it carefully and benchmark it.

### 5.1 Durable queue choice — do not choose by fashion

Evaluate the current Supabase/PostgreSQL-backed state before introducing another infrastructure dependency.

Candidates to compare where appropriate:

- PostgreSQL durable queue using transactional claiming and `FOR UPDATE SKIP LOCKED`
- Redis-based queue
- NATS JetStream
- RabbitMQ
- A dedicated workflow engine such as Temporal or another suitable durable workflow runtime
- A hybrid design (database as source of truth, broker as notification/dispatch layer)

Compare:

- Delivery and acknowledgement semantics
- At-least-once behavior and duplicate handling
- Ordering needs
- Delayed jobs and retries
- Visibility timeouts/leases
- Backpressure and queue growth
- Multi-tenant fairness
- Recovery and replay
- Operational burden
- Cost on small VPS deployments
- Compatibility with current Render/Supabase architecture
- Failure modes when database, broker, worker, or provider is unavailable

Do not add Redis, NATS, RabbitMQ, Temporal, Kubernetes, or another service unless it solves a demonstrated problem better than the simplest existing option. Extra services create cost and operational failure modes.

If PostgreSQL is selected:

- Claim work in short transactions.
- Use row locking and `SKIP LOCKED` or another justified atomic claim method.
- Never keep a DB transaction open while a task executes.
- Use leases, heartbeats, and fencing/version tokens.
- Add the right partial indexes and query-plan tests.
- Ensure queue polling does not overload the primary database.
- Separate notifications/wakeup hints from durable source-of-truth state if necessary.
- Measure lock contention, queue latency, DB connections, and vacuum/table bloat.

### 5.2 Task state machine

Design and document explicit, validated transitions. A possible state model is:

`CREATED → QUEUED → ADMITTED → ASSIGNED → STARTING → RUNNING → CHECKPOINTING → SUCCEEDED`

Additional terminal or recovery states may include:

`RETRY_WAIT`, `CANCEL_REQUESTED`, `CANCELLED`, `FAILED`, `EXPIRED`, `DEAD_LETTERED`, `RECOVERING`.

This is illustrative. Reuse or refine existing Kriya states if they already provide equivalent guarantees.

For every transition define:

- Actor allowed to perform it
- Preconditions
- Transaction boundary
- Idempotency behavior
- Lease/fencing requirements
- Audit event
- Recovery behavior
- Metrics emitted

Reject invalid transitions. Use optimistic versioning or equivalent concurrency control to prevent stale workers from overwriting newer task state.

### 5.3 Fairness and priority

Evaluate and implement an appropriate combination of:

- Weighted fair queuing or deficit round robin per tenant
- Per-tenant and per-agent concurrency ceilings
- Priority classes for interactive versus background work
- Priority aging to prevent starvation
- Deadline-aware scheduling where meaningful
- Per-task resource reservations
- Maximum queue length and admission rejection/defer policy
- Tenant quotas and plan entitlements

A high-priority customer must not be able to starve every other tenant. A free/basic tier must not be able to monopolize the worker pool.

### 5.4 Resource-aware scheduling

Schedule using measured resources rather than task count alone.

At minimum track:

- CPU capacity and recent utilisation/load
- Memory available, reservations, and pressure
- Disk space and I/O pressure
- Process/PID capacity
- Number of active containers and worker slots
- Network/egress capacity where measurable
- Node health and drain state
- Per-task declared and observed resource use

Use reservations and safety headroom. A task should be admitted only when its resource class fits within the safe budget. Prevent oversubscription from turning into host OOM or noisy-neighbor instability.

Explore bin-packing/resource-fit heuristics, but do not over-optimise before workload data exists. Compare a simple conservative first-fit/best-fit strategy against more complex schedulers using a benchmark.

### 5.5 Backpressure and overload behavior

Define deterministic behavior when:

- Queue depth exceeds configured thresholds
- Queue wait exceeds SLO
- CPU or memory pressure is high
- No healthy node is available
- A tenant reaches its concurrency or usage quota
- The provider or database is degraded
- The node is draining or restarting

Prefer safe queueing, controlled rejection with a retryable response, or explicit quota errors over accepting unlimited work. Never silently drop customer tasks.

### 5.6 Cancellation and deadlines

Cancellation must propagate from user to orchestrator, worker, and execution process group/container. Enforce hard wall-clock limits and cleanup even when a command ignores graceful termination. Define escalation from graceful stop to forced kill. Record whether cancellation completed and whether resources were reclaimed.

---

## 6. Worker protocol and distributed reliability

Implement or refine a worker protocol with:

- Authenticated worker registration
- Unique worker/node identity
- Heartbeat and health state
- Capacity advertisement
- Pull-based task claiming or an equally robust dispatch strategy
- Time-bounded task leases
- Fencing tokens or monotonically increasing execution epochs
- Graceful drain and shutdown
- Cancellation acknowledgement
- Resource usage reporting
- Worker version and runner-image digest
- Compatibility negotiation
- Task result acknowledgement

A stale worker must not be able to commit task results after its lease expires and a replacement worker has taken over.

### 6.1 Delivery semantics

Assume at-least-once execution unless you prove a stronger guarantee. Do not claim exactly-once execution merely because the queue has acknowledgements.

Use:

- Idempotency keys for task submissions and external actions
- Unique constraints for deduplication
- Transactional outbox/inbox patterns when state changes and event publication must be atomic
- Fencing tokens for stale worker protection
- Reconciliation for uncertain external side effects
- Explicit compensation where an operation cannot be made idempotent

Never blindly retry non-idempotent side effects such as payments, messages, deployments, or publication.

### 6.2 Retry policy

Implement bounded retries with exponential backoff and jitter, per-error classification, deadlines, and retry budgets. Distinguish:

- Transient infrastructure failures
- Provider rate limits
- User command failures
- Invalid configuration
- Permission/security denials
- Resource exhaustion
- Permanent application errors

Do not retry a user command failure as though it were a provider outage. Do not create retry storms.

### 6.3 Recovery and checkpoint semantics

Define exactly what a checkpoint contains and what it does not contain. Consider:

- Pinned repository commit and working-tree diff
- Workspace/artifact references
- Task graph state
- Completed step outputs
- Command exit codes and bounded logs
- Dependency/cache identifiers
- Runner image and toolchain digest
- Execution epoch/version
- Required non-secret environment metadata

Do not serialize or persist secrets in checkpoints. Ensure checkpoint writes are atomic or content-addressed and integrity-checked. Define behavior for a crash during checkpoint creation.

Checkpoint at meaningful stage boundaries rather than after every tiny operation if the overhead is not justified. Benchmark the trade-off.

---

## 7. Sandbox isolation and Linux hardening

This section is a release blocker for arbitrary customer code.

### 7.1 Threat model

Assume a customer task may be malicious or compromised. Consider:

- Container escape attempts
- Kernel attack surface
- Privilege escalation
- Filesystem traversal and symlink attacks
- Access to another tenant's data
- Access to worker/control-plane credentials
- Cloud metadata endpoint access
- SSRF and DNS rebinding
- IPv4 and IPv6 egress bypass
- Unix socket exposure
- Docker/container runtime socket abuse
- Fork bombs and PID exhaustion
- Memory exhaustion/OOM
- Disk exhaustion and inode exhaustion
- CPU exhaustion and denial of service
- Network flooding
- Malicious package lifecycle scripts
- Supply-chain compromise
- Log/output exfiltration
- Workspace reuse and residual-data leakage

Write a threat model with trust boundaries, attacker capabilities, mitigations, residual risks, and tests.

### 7.2 Evaluate runtime choices

Compare, with evidence and compatibility tests:

- Rootless Docker
- Docker with a hardened daemon and user namespace remapping where available
- containerd and appropriate runtimes
- gVisor (`runsc`)
- Kata Containers where the host supports it
- Firecracker only if the required KVM capabilities are actually available
- A managed provider for workloads that require stronger isolation than the self-hosted node can demonstrate

Do not assume that Docker alone is a strong boundary for hostile multi-tenant code. Do not claim gVisor, Kata, or Firecracker is installed or effective until validated on the actual host and in the target configuration.

Probe the real Hostinger environment for:

- cgroup v2 and controller availability
- namespaces and user namespaces
- seccomp
- AppArmor or another MAC mechanism
- rootless runtime support
- overlay filesystem behavior
- required capabilities
- `/dev/kvm` and virtualization support, if considering a microVM runtime
- network namespace and firewall behavior
- kernel version and relevant mitigations

If a security capability is unavailable, fail closed or route the workload to a stronger provider. Do not silently downgrade isolation.

### 7.3 Mandatory container controls, if containers are selected

Apply and test the appropriate controls, including:

- Unprivileged non-root task identity
- No privileged containers
- No host PID, IPC, or network namespace sharing
- No host filesystem mounts except narrowly scoped task storage
- Never mount the Docker/container runtime socket into task containers
- Drop Linux capabilities by default
- No-new-privileges
- Seccomp profile
- AppArmor/SELinux policy where available
- Read-only root filesystem where practical
- Per-task writable workspace with quotas
- CPU, memory, PID, I/O and wall-clock limits
- Ulimits and file descriptor limits
- Separate temporary directories
- Controlled environment variables
- No host secrets
- No broad host paths
- Image pinning by immutable digest
- Image scanning and provenance checks
- Cleanup on success, failure, timeout, cancellation, and worker death

Document every exception and why it is needed.

### 7.4 Network egress security

Design a deny-by-default or tightly allowlisted egress model appropriate for the workload. Evaluate an authenticated egress proxy and network namespaces/firewall rules.

Explicitly test blocking access to:

- Loopback and host services
- Private address ranges not required by the task
- Link-local addresses
- Cloud metadata endpoints
- Render, Supabase, worker, and internal control-plane endpoints
- Host/container runtime sockets
- IPv6 routes that bypass IPv4 policy
- DNS rebinding and alternate-resolution paths

Allow only required destinations (for example, approved source control and package registries) through an auditable policy. Account for dynamic registry/CDN endpoints; do not pretend a simple hostname list provides complete security. Ensure firewall setup fails closed if it cannot be applied.

Do not inject long-lived GitHub, npm, cloud, database, or model credentials into the sandbox. Use a narrow trusted broker or short-lived scoped credentials where a task genuinely requires authentication.

### 7.5 Tenant data boundaries

- Task workspaces must be tenant- and task-scoped.
- Never reuse writable workspaces between tenants.
- Keep caches immutable or content-addressed and verify integrity.
- Encrypt durable artifacts where appropriate.
- Apply retention and deletion policies.
- Avoid sensitive values in logs and traces.
- Enforce authorization in the trusted control plane and database RLS.
- Test cross-tenant access at API, storage, worker, and runtime boundaries.

### 7.6 Security release rule

If the self-hosted isolation boundary cannot pass the threat-model-driven tests, restrict it to trusted/internal workloads and keep untrusted arbitrary code on a stronger managed/dedicated isolation provider. A lower bill does not justify exposing customer environments to cross-tenant compromise.

---

## 8. Compute efficiency and cost optimisation

The primary optimisation target is **cost per successful, verified task**, not simply cost per hour or tasks started per second.

### 8.1 Measure before optimising

Build a baseline for each workload class with:

- CPU seconds
- Peak and average RSS/memory
- Disk bytes and I/O
- Network bytes
- Workspace startup time
- Queue wait time
- Execution time
- Cache hit/miss
- Retry count
- Failure category
- Successful completion rate
- Total cost estimate

Include control-plane, database, storage, egress, and operational costs in the cost model, not just VPS rental.

### 8.2 Optimisation candidates to evaluate

Evaluate only when compatible with correctness and isolation:

- Event-driven agent orchestration rather than resident idle processes
- Bounded worker pools
- Dynamic resource classes
- Adaptive concurrency using CPU and memory pressure
- Resource-aware admission control
- DAG decomposition for independent work
- Avoiding duplicate agent exploration and duplicate tool calls
- Cancellation of redundant or superseded work
- Warm worker/container pools with strict identity reset
- Immutable base images
- Dependency cache keyed by lockfile, toolchain, OS/architecture, and image digest
- Content-addressed artifact storage and deduplication
- Git shallow/sparse checkout where appropriate
- Incremental builds and test selection where correctness permits
- Output streaming with size limits and compression
- Model/tool-call caching only where results are safe, deterministic enough, tenant-scoped, and do not contain secrets
- Batch small compatible operations where it reduces overhead
- Work stealing only if it preserves fairness and task affinity
- Idle node scale-down when supported and economically sensible

Do not share mutable workspaces between tenants. Do not let caches become a cross-tenant data leak or supply-chain poisoning vector. Verify cache keys and content integrity.

### 8.3 Avoid premature infrastructure complexity

Do not introduce Kubernetes, service meshes, multiple message brokers, Redis, a second database, or a complex autoscaler by default. First determine whether the existing Render/Supabase architecture and a small node supervisor can meet measured needs.

Choose the simplest architecture that satisfies the required safety and reliability properties. Add complexity only when a benchmark or failure analysis demonstrates the need.

### 8.4 Capacity planning

Measure the actual Hostinger KVM2/KVM4 hardware and the runner's overhead. Calculate safe task concurrency from measured CPU, memory, disk, and PID budgets with safety headroom.

Do not state that a KVM4 can support a fixed number of tasks before running the benchmark suite. Report separate figures for:

- Logical agents/sessions
- Queued jobs
- Active lightweight jobs
- Active standard jobs
- Active heavy jobs
- Sustainable mixed workload concurrency

Use load tests to locate saturation points and establish an operating envelope below the failure cliff.

---

## 9. Storage, artifacts, and workspace lifecycle

Evaluate the current Kriya storage implementation before adding new systems.

Requirements:

- Durable task state stored separately from ephemeral runner disks.
- Durable artifacts stored in an appropriate object store or existing supported storage layer.
- Local node disk used only for bounded temporary execution data and caches.
- Atomic artifact/checkpoint upload and verified references.
- Per-tenant and per-task quotas.
- Disk/inode pressure monitoring.
- Retention, expiry, and deletion workflow.
- Cleanup janitor for orphaned workspaces, containers, mounts, and artifacts.
- No cleanup of resources owned by a live task or another tenant.
- Idempotent cleanup operations and audit events.
- Integrity validation when resuming or restoring artifacts.

For Git workspaces, pin the source revision and record the resulting change set. Ensure a restarted task can identify whether it should resume, re-import, or stop due to an invalidated source revision.

---

## 10. Observability and operations

Instrument the control plane, scheduler, worker, runtime, provider adapters, and task lifecycle.

Use OpenTelemetry or an existing compatible tracing system if appropriate. Avoid introducing an observability stack whose resource cost exceeds the workload without a clear reason.

### 10.1 Required metrics

At minimum:

- Queue depth by priority and tenant (with privacy-safe labels)
- Oldest queued task age
- Queue wait p50/p95/p99
- Admission accepted/deferred/rejected counts and reasons
- Active tasks by workload class
- Node CPU, load, memory, swap, disk, inode, PID, and network pressure
- Worker heartbeat age and worker health
- Workspace startup p50/p95
- Execution duration p50/p95
- Task success and failure rate by failure class
- Retry and dead-letter rate
- Cancellation latency and cleanup duration
- Checkpoint/restore success and latency
- Cache hit/miss and time saved
- Per-tenant resource consumption and fairness
- Cost per successful task
- Cross-tenant authorization denials and security events

### 10.2 Required logs and traces

Use correlation identifiers for tenant, agent, task, attempt, worker, workspace, and trace. Do not use sensitive user data as metric labels. Redact credentials and secrets. Bound log size, retention, and output capture.

### 10.3 Alerts and runbooks

Create actionable alerts and runbooks for:

- Queue backlog/latency breach
- Worker heartbeat loss
- OOM or repeated resource exhaustion
- Disk/inode pressure
- Database connection or query saturation
- Provider outage or authentication failure
- High retry/dead-letter rate
- Checkpoint corruption/failure
- Cleanup backlog
- Egress policy failure
- Suspected cross-tenant access
- Cost/usage anomaly

Document node drain, maintenance, restart, replacement, backup/restore, and incident procedures.

---

## 11. Reliability targets, SLOs, and graceful degradation

Do not assert that the platform is 90–100% reliable without measuring a defined time window and denominator. Define service indicators and targets with the product owner.

Candidate indicators:

- Successful task completion rate for eligible tasks
- Queue wait latency by workload class
- Workspace startup latency
- Task state durability after worker/node restart
- Recovery success rate
- Cleanup success rate
- API availability
- Cross-tenant isolation test pass rate
- Data-loss and duplicate-side-effect incidents

For each SLO specify:

- Exact numerator and denominator
- Exclusions (if any)
- Measurement window
- Target
- Error budget
- Alert thresholds
- Owner and response procedure

A single VPS cannot provide high availability against node/host/provider failure. State that clearly. If the product requires an availability SLO that one node cannot satisfy, propose the cheapest credible multi-node or managed fallback design and its incremental cost. Do not pretend local retries remove a single point of failure.

Implement graceful degradation, for example:

- Continue accepting and storing tasks when no execution slot is available, within queue limits.
- Return clear retryable overload status when capacity is exhausted.
- Keep task history and completed artifacts accessible during worker outages when the control plane is healthy.
- Route eligible workloads to E2B/Daytona only when configured, permitted, budgeted, and security-compatible.
- Disable new self-hosted admission when security policy cannot be enforced.
- Preserve existing tasks and safely drain workers during maintenance.

---

## 12. Benchmarking, load tests, and chaos tests

Build repeatable tests. Never infer capacity from a few successful manual jobs.

### 12.1 Concurrency profiles

Test at gradually increasing logical session counts such as 10, 25, 50, 100, 250, and 500, but distinguish idle/waiting sessions from active jobs.

Test workload mixes with increasing active execution concurrency and different ratios of lightweight, standard, heavy, and background work. Use the same task corpus and runner image across provider comparisons.

Do not jump directly to a stress level that risks an uncontrolled bill or damages a shared environment. Use a staging node and explicit cost caps.

### 12.2 Failure injection

Test at least:

- Worker process crash during execution
- Worker crash during checkpoint upload
- Node reboot while tasks are queued and running
- Network partition between control plane and node
- Database unavailable or connection pool exhausted
- Queue claim race between workers
- Lease expiry while old worker is still alive
- Duplicate task submission
- Duplicate result delivery
- Provider API timeout/rate limit
- Disk full and inode exhaustion
- Memory pressure/OOM
- Process/PID exhaustion
- Slow or unreachable artifact storage
- Malformed/oversized command output
- Cancellation during a long-running process
- Janitor racing with a live workspace
- Tenant quota exhaustion
- Egress policy initialization failure

Verify that customer tasks are not silently lost, stale workers cannot commit, side effects are not duplicated, and resources are eventually cleaned up.

### 12.3 Benchmark outputs

Publish a benchmark report containing hardware and image details, kernel/runtime versions, task corpus and commit, workload mix, test duration, concurrency, all latency percentiles, throughput, success rate, resource graphs, failures, and cost per successful task.

Report p50, p95, and p99 where sample size permits. Include confidence/limitations. Do not report averages alone.

---

## 13. Test strategy and release gates

Every implementation slice must include tests. At minimum:

### Unit tests

- State transition validity
- Scheduler priority and fairness
- Resource admission calculations
- Quota enforcement
- Idempotency and duplicate submissions
- Retry classification/backoff
- Lease/fencing behavior
- Cancellation/deadline handling
- Cache key construction and tenant isolation
- Cleanup ownership checks

### Integration tests

- Database queue claims under concurrency
- Worker heartbeat and lease expiration
- Worker restart/recovery
- Self-hosted provider contract
- Existing E2B/Daytona provider contract regression
- Checkpoint/restore
- Artifact storage
- Secret-broker boundaries
- Egress policy
- Tenant-level authorization/RLS

### End-to-end tests

- Submit task → queue → schedule → execute → checkpoint → result
- User cancellation → process termination → cleanup
- Worker loss → lease expiry → recovery
- Approved GitHub handoff through the existing trusted workflow
- Customer A cannot observe or modify Customer B's workspace/artifacts

### Security tests

- Privilege escalation attempts
- Runtime socket access attempts
- Metadata/private network access
- IPv4/IPv6 egress bypass attempts
- Symlink/path traversal
- Resource exhaustion
- Cross-tenant artifact access
- Secret exposure in environment/logs/checkpoints
- Malicious package/script behavior

### Regression gates

- Existing Cloud tests
- Existing Harness tests
- Existing Rooms tests if shared infrastructure is affected
- Typecheck, lint, format, unit tests, integration tests, build, migration tests, readiness checks
- All current CI failures investigated, not hidden or skipped

Never disable a meaningful existing test, remove a security assertion, or widen permissions merely to get a green build.

---

## 14. Implementation plan

Work in small, reviewable phases. After each phase: run relevant tests, run regression tests, update docs/status, report evidence, and stop at external approval gates.

### Phase 0 — Audit and architecture decision

Deliver:

- Repository discovery report
- Current-state architecture map
- Workload model and benchmark plan
- Hostinger capability checklist
- Threat model
- Comparison of queue/runtime/workflow alternatives
- Cost model and staged plan
- Architecture decision records (ADRs) for material choices

No production changes.

### Phase 1 — Contract and state-machine alignment

- Reuse/extend the current provider abstraction.
- Define worker protocol and state transitions.
- Define resource classes and tenant quotas.
- Define idempotency, lease, fencing, and cancellation semantics.
- Add schema migrations only after reviewing existing schemas and RLS.
- Preserve existing provider compatibility.

### Phase 2 — Self-hosted worker vertical slice

Build the smallest end-to-end path:

1. Control plane enqueues an authorised task.
2. Scheduler admits it within configured resource limits.
3. Self-hosted worker claims it with a lease/fencing token.
4. Worker launches one restricted task environment.
5. Command runs with CPU/RAM/PID/time/output limits.
6. Result and bounded logs are persisted.
7. Workspace is cleaned up.
8. Task state is final and auditable.

Start staging-only, with feature flags disabled by default.

### Phase 3 — Scheduling and multi-tenant controls

- Durable queue and atomic claim
- Fair scheduling
- Admission control and backpressure
- Resource reservations and adaptive concurrency
- Per-tenant/agent quotas
- Queue age and starvation prevention
- Cancellation and deadlines

### Phase 4 — Recovery and durability

- Leases and heartbeat
- Fencing tokens
- Checkpoint integrity and restoration
- Idempotent retries
- Outbox/reconciliation where required
- Worker/node interruption recovery
- Janitor and orphan cleanup

### Phase 5 — Security hardening

- Host capability audit
- Runtime selection and hardening
- Network egress enforcement
- Secret broker or mediated credentials
- Cross-tenant tests
- Adversarial workload suite
- Security review and explicit workload eligibility policy

Do not enable untrusted customer code if the required isolation tests fail.

### Phase 6 — Performance and cost optimisation

- Baseline and tune resource classes
- Warm pools if beneficial
- Verified immutable dependency cache
- DAG execution/parallelism controls
- Incremental build/test strategies if correctness is preserved
- Output and artifact efficiency
- Capacity envelope for each workload mix
- Cost per successful task report

### Phase 7 — Multi-node readiness and operations

- Node registration, health, draining, and replacement
- Multiple node scheduling if needed
- Operational metrics, dashboards, alerts, and runbooks
- Backup/restore and disaster recovery
- Explicit single-node limitations

Do not deploy a second node unless benchmark/SLO evidence justifies it or a required availability target demands it.

### Phase 8 — Controlled pilot and release decision

- Named staging/pilot users
- Explicit workload eligibility
- Cost caps and alerts
- Incident and rollback process
- Defined pilot duration and success criteria
- No unresolved critical/high security issues
- No silent task loss or cross-tenant leaks
- Evidence-based decision on beta/GA flags

Do not change Kriya Harness release stage from Beta to GA as part of this work unless all separate Harness release gates are satisfied and the owner explicitly approves the release decision.

---

## 15. Hostinger-specific staging checklist

Before installing or provisioning anything, verify the exact VPS plan and terms.

Collect and record (without secrets):

- Plan and region
- Actual vCPU/RAM/storage/network limits
- CPU model/virtualization details where exposed
- Kernel version
- cgroup mode and enabled controllers
- Namespace and user-namespace support
- seccomp and AppArmor/SELinux availability
- Rootless container runtime support
- Docker/containerd version
- `/dev/kvm` presence and permission only if evaluating KVM-dependent runtimes
- Firewall/network namespace capability
- Disk filesystem and quotas
- Backup/snapshot availability and cost
- Network transfer limits and egress cost
- Provider terms relevant to running customer code and public execution workloads

Do not infer Hostinger plan capabilities from marketing labels. Validate on the actual instance.

Start with staging data and strict budget controls. Do not install a runtime or modify firewall rules on a production server without owner approval and a recovery plan.

---

## 16. Cost model and decision framework

Compare at least:

1. Existing managed E2B/Daytona usage
2. Self-hosted Hostinger node
3. Self-hosted cloud node from another provider if needed
4. Hybrid routing between self-hosted and managed execution

Count:

- VPS/server rent and renewal pricing
- Storage and backup
- Network transfer/egress
- Database connection and storage costs
- Artifact storage and retention
- Logs/metrics/tracing
- Provider charges
- Idle capacity
- Engineering and operations burden
- Recovery/failure cost
- Security boundary cost

Primary metric:

`cost_per_successful_task = total attributable infrastructure + service cost / number of successfully verified eligible tasks`

Also report cost per workload class and per tenant tier. Do not optimize for cost by silently reducing isolation, dropping logs needed for audits, or increasing task failure rates.

Choose a provider-routing policy based on eligibility, isolation, latency, capacity, and budget. A managed provider may remain the safer option for certain untrusted or bursty workloads even when its nominal compute price is higher.

---

## 17. Configuration and rollout safety

- New self-hosted provider must be disabled by default.
- Use separate staging and production configuration.
- Keep provider credentials server-side and scoped to the required worker only.
- Never expose secrets to browser bundles, task containers, logs, artifacts, or checkpoints.
- Use explicit allowlists for tenants/workloads permitted to use self-hosted execution.
- Implement a fast kill switch for new admissions.
- Support draining and disabling a node without corrupting active tasks.
- Define rollback to existing E2B/Daytona or safe queued state.
- Do not change the current provider default or `cloud.publish` behavior without approval.
- Do not enable GitHub publishing merely because self-hosted execution works; publication must retain its existing user-approval and authorization gates.

External account creation, paid plan selection, VPS purchase, DNS changes, production secrets, migrations on production, and deployments require owner approval. You may prepare instructions and local/staging code, but do not incur spend or mutate production autonomously.

---

## 18. Research requirement: challenge this proposal

Before locking the design, research current primary-source documentation and evaluate more than one option in each important area.

Research and compare, as relevant:

- Durable queue and workflow engines
- PostgreSQL queue patterns and connection-pool implications
- Linux container isolation and rootless runtimes
- gVisor, Kata Containers, Firecracker, and provider-specific sandbox properties
- cgroup v2 resource accounting and enforcement
- Network egress controls and proxy designs
- OpenTelemetry and low-overhead observability
- Adaptive concurrency and load-shedding algorithms
- Fair queueing and multi-tenant scheduling
- Content-addressed caching and build cache security
- Checkpoint/restore approaches
- Hostinger's current virtualization and acceptable-use constraints

Use authoritative primary sources where possible: official project documentation, upstream repositories, standards, security advisories, and provider documentation. Record retrieval dates and relevant versions. Do not cite marketing claims as proof of security. Verify current pricing separately and do not hard-code it into the system.

For each major choice, document:

- Selected option
- Alternatives considered
- Why the selected option fits Kriya's actual workload and current stack
- Cost and operational complexity
- Security implications
- Known limitations
- Conditions that would trigger reconsideration

The goal is not to use the most fashionable technology. The goal is the best measured outcome for Kriya.

---

## 19. Definition of done

This programme is not complete merely because code compiles or a container starts.

The self-hosted provider can be marked **implemented** only when the end-to-end staging workflow works using the actual target host.

It can be marked **security-validated for a workload class** only when the documented isolation, network, secret-boundary, and tenant-separation tests pass for that class. Do not generalise a test result beyond the environment and workload it covered.

It can be marked **pilot-ready** only when:

- No unresolved critical/high security issues remain for the permitted workload class.
- Durable queue and state recovery tests pass.
- Worker/node interruption tests pass.
- Resource limits and overload behavior are verified.
- Cross-tenant isolation tests pass.
- Cleanup and retention tests pass.
- Monitoring, alerts, and runbooks exist.
- Cost per successful task is measured.
- Queue, latency, and task-success targets are defined and met in staging.
- Existing Cloud/Harness regressions pass.
- Rollback and kill-switch behavior is tested.
- Owner approves pilot scope and budget.

It can be considered **production-ready for a defined workload class** only after a controlled pilot provides sufficient evidence, operational ownership is assigned, availability/recovery limitations are documented, and all release/legal/security gates are approved.

Do not use one universal “production ready” label for all workload types. Trusted internal scripts, normal development tasks, and hostile arbitrary code have different isolation requirements.

---

## 20. Required deliverables

Create or update repository documentation as appropriate. Avoid duplicate or contradictory plans.

Required outputs:

1. `docs/cloud-execution/SELF_HOSTED_ARCHITECTURE_AUDIT.md` — current-state audit and architecture decision
2. `docs/cloud-execution/SELF_HOSTED_ARCHITECTURE.md` — approved target architecture and diagrams
3. `docs/cloud-execution/SELF_HOSTED_THREAT_MODEL.md` — trust boundaries, threats, mitigations, residual risks
4. `docs/cloud-execution/SELF_HOSTED_OPERATIONS_RUNBOOK.md` — deploy, drain, restart, recover, clean, rollback, incident procedures
5. `docs/cloud-execution/SELF_HOSTED_BENCHMARK_PLAN.md` — workloads, load profiles, measurements, acceptance thresholds
6. ADRs for queue, runtime/isolation, scheduler, storage/checkpoint, and provider-routing decisions where material
7. Code, migrations, configuration schema, tests, and CI coverage for the implementation
8. Updated status ledger with evidence-backed phase states
9. A benchmark report for the target Hostinger staging machine
10. A release-readiness report including open risks, owner actions, and workload eligibility

If equivalent documents already exist, update them instead of creating redundant files.

---

## 21. Final report format

At the end of each work session, report:

### Repository baseline
- Branch and commit
- Working-tree changes preserved
- Existing CI status and failures

### Architecture decisions
- What was selected
- What alternatives were evaluated
- Why the selected design is better for this repository
- What remains uncertain

### Implementation
- Files/modules changed
- Migrations and configuration changes
- Compatibility impact

### Verification
- Exact commands executed
- Unit/integration/e2e/security/load test counts
- Passed/failed/skipped results
- Staging environment and runner image digest
- Benchmark measurements and sample size

### Security and reliability
- Threats tested
- Controls verified
- Known limitations and residual risks
- Failure/recovery outcomes

### Economics
- Measured resource usage
- Cost per successful task
- Capacity envelope by workload class
- Whether a larger node or second node is justified by evidence

### Remaining work
Classify each item as:

- `COMPLETE` — evidence exists and acceptance criteria pass
- `IN_PROGRESS` — implementation exists but verification remains
- `BLOCKED` — external dependency or owner decision is required
- `NOT_STARTED` — no implementation/evidence yet

Never mark an item complete merely because code was written.

---

## 22. Non-negotiable engineering principles

1. **Measure before scaling.** Do not purchase larger infrastructure until profiling demonstrates the need.
2. **Optimize successful work, not agent count.** Logical agents are not the same as CPU-bound jobs.
3. **Persist workflow state.** Do not rely on a live process as the only copy of task progress.
4. **Assume retries and duplicates.** Design idempotency, leases, fencing, and reconciliation.
5. **Fail closed on security controls.** No sandbox if required isolation or egress policy cannot be enforced.
6. **Keep tenants separate.** No cross-tenant writable workspace, secret, artifact, or cache leakage.
7. **Keep providers replaceable.** Self-hosting must not couple the Harness to Hostinger-specific APIs.
8. **Avoid premature complexity.** Every service and algorithm must justify its cost and operating burden.
9. **Preserve existing functionality.** Do not rebuild the Harness or Cloud system unnecessarily.
10. **No false guarantees.** Reliability is measured over time; 100% cannot be promised.
11. **Staging before production.** No unapproved production deployments, spend, or destructive changes.
12. **Evidence over status labels.** Report actual tests and limitations honestly.

**End of specification.**
