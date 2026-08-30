# agent-leases

A pattern for many autonomous agents sharing one resource on a laptop or in the cloud,
so that no agent modifies the resource while another agent's run depends on it, and so
that agents can talk to each other before a shared resource changes.

The resource can be anything several agents reach at once and one of them sometimes has
to change: a local database, a container runtime, a dev server, a device, an emulator, a
shared cache, a staging environment. The pattern was worked out for a local Supabase
shared by several coding agents in git worktrees, where worktrees isolate files but not
the database. It is written here without that specificity so it can be applied to any
shared thing.

This repository holds the pattern, its rationale, the decisions behind it, and the
findings from its first implementation. See [Status](#status).

## The problem

Agents working in parallel are given isolated copies of the code, and they behave as if
everything else were isolated too. It is not. Two agents that both reach the same
database, container or server will, sooner or later, do this:

1. Agent A starts a long run (a test suite, a migration check, a build) that depends on the
   resource staying as it is.
2. Agent B, unaware, resets, restarts or reshapes the resource.
3. A's run fails in a way that looks like flaky tests or broken code. A investigates its own
   work. B never learns it caused anything.

The failure is silent, mis-attributed and expensive. Discipline ("only one agent touches
the database") does not survive a second session, a new crew, or a tool that runs its own
worktree out of sight.

## The pattern in one paragraph

**Using** a shared resource is not the problem; **changing** it is. So readers coexist and
only modifiers have to ask. Every user of the resource holds a lightweight *lease* that
says who they are, what they are doing, how long they expect to need it, and how
important it is. A modifier that wants to change the resource looks at the live leases,
posts a *request* saying what it wants, why, and for how long, and the readers get a say:
*go ahead*, *I need N more minutes*, or silence, which is never treated as consent.
Modifiers queue in the order they asked. Before any use, each agent runs a cheap
*preflight* that compares what its checkout expects with what the resource actually holds,
and the resource converges to the union of everyone's work rather than being reset to
match any one agent.

No daemon, no queue process, no scheduler. State is a directory of small files. The
happy path is one file write and one check.

## The model

### Tools form a dependency graph

Every shared thing is a *tool*, and tools declare what they depend on. A project's
database depends on its container stack; the stack depends on the container runtime. A
future device, emulator or staging environment is another node, with its own
dependencies.

```
docker                      the container runtime on this machine
  └── supabase:<project>    one project's local stack: containers, ports
        └── db:<project>    that project's schema and data
```

Two rules, and they are mirror images:

- **A reader registers on the most specific tool it uses.** A test suite and a psql session
  use the schema and the data, so they register on `db`. A dev server needs the stack up
  and survives a rebuild of its contents, so it registers on `supabase`. Anything bound to
  the containers themselves registers on `docker`.
- **A modifier of tool X consults the readers of X and of everything that depends on X,
  transitively.** Never anything X depends on, never a sibling. A reader is blocked only by
  a live write lease on its own tool or on something its tool depends on.

Why a graph rather than a list of scopes: it replaces two special cases (project scope,
machine scope) with one relation, and it buys a distinction a flat model cannot express:
*changing what is in a resource* is a smaller act than *taking the resource away*, and
only the second one has to interrupt a dev server. A `db` reset never asks the dev server;
a container-runtime restart asks everyone.

Tool ids are a machine-global namespace: `type` for singletons (`docker`), `type:instance`
otherwise (`db:my-project`). Agree the namespace before a second project adopts the
pattern. Each tool adapter declares its dependencies and its actions, tagged reader or
modifier, and the graph is written once beside the state so a status command can draw it.

### Readers and modifiers

| | Readers | Modifiers |
| --- | --- | --- |
| What they do | Use the resource as intended: run tests against it, query it, serve from it | Change its shape or availability: reset, restart, migrate, rebuild, stop |
| How many at once | Any number | One per tool at a time, in the order they asked |
| What they hold | A **read lease** | A **write lease** |
| When they wait | Only when *starting* while a write lease is already active on their tool or on something it depends on; then they wait (with a progress line) rather than fail against a half-built resource. A running reader never waits and is never interrupted | While any live reader has not consented, and behind any earlier modifier in the queue |

### The lease

A lease is a small file in a shared state directory outside every checkout. It records:

- `pid` (or an equivalent liveness handle), so a dead holder can be detected and ignored
- `kind`: read or write
- `purpose`: what the holder is doing, in words a human can read in a refusal message
- `where`: the checkout, branch, or session it belongs to
- `started_at` and `expected_until`: an honest estimate, measured from recent runs where
  possible, so others can plan around it
- `interruptible`: consent given in advance. An interruptible reader (a dev server) is
  notified and not waited for, and can withdraw consent by answering *need N*. An unattended
  test run is not interruptible
- `importance`: normal or high. A high-importance lease is never treated as interruptible,
  whatever its flag says
- a random `token`, so only the holder can release its own lease

Leases are released on normal exit and on signals. A holder that dies without releasing
leaves a file whose pid is dead; the next check ignores it and cleans it up. There is no
manual cleanup in the normal case, and a `--force` for the abnormal one. An unreadable
lease file is treated as a live, non-interruptible reader (fail closed), because files are
written atomically and a file that still will not parse is corruption, not a partial read.

### The request, and the three answers

When a modifier finds live read leases, it posts a *request* file: what it wants (reset,
restart, migrate), its own estimate, who it is, an `urgency` (normal or urgent), and a
short free-text `message` saying why ("resetting to apply the correction migrations",
"restarting the runtime to clear a hung container"). The message is required when the
request is urgent. Readers see it in the status command and in every refusal, so a running
agent can judge whether its own work is important enough to ask for time, or is itself
dependent on the change and should say go ahead.

A reader answers in one of three ways:

| Answer | Meaning |
| --- | --- |
| **ok** | Go ahead now. I am done, or my run can be sacrificed and re-run. |
| **need N** | Wait; I need about N more minutes. Extends my `expected_until`. |
| **silence** | Treated as "I need it until my `expected_until`". Never as consent. |

Silence is the important one. Most readers are unattended runs that cannot respond, and
the whole point is that they are not destroyed. Their estimate speaks for them, and **an
estimate that has run out still does not authorise anybody**: a live, non-interruptible
reader blocks until it releases, answers ok, or is forced by a human. The estimate is for
planning and for the message only.

The modifier then:

- proceeds, if every live reader consented (answered ok, or is interruptible) or every read
  lease is stale;
- waits, under a `--wait` flag, until the leases are gone or answered ok;
- otherwise exits with a distinct "temporarily unavailable" code and a message naming the
  holders, their purposes and the earliest time it could proceed, so the calling agent can
  choose to wait, do something else, or escalate to a human.

A request belongs to its live poster: it is removed when the poster exits or withdraws it,
so the status view never fills with questions nobody is asking. That ownership covers every
copy: when a modifier of a shared root posts its request into each dependent tool that has a
reader, it removes or marks every one of those copies on every exit path, not just the copy
in its own tool, or a reader's status shows an open question about work that already
finished. Replies live in the
reader's own lease file, keyed by request id, so each file has one writer.

### Modifiers queue

Two modifiers do not race and are not refused. Requests are timestamped, so the earlier
one goes first and the later one waits its turn. When its turn comes, a modifier re-runs
its preflight and skips if the work is already done: two "apply the missing migrations"
requests coalesce naturally, because the second finds nothing left. Coalescing is per tool
and decided by that re-check, never by comparing action names, and requests on different
tools are never compared.

Exclusivity between modifiers is a second rule, separate from consultation, and it runs in
both directions along the graph: a modifier of X is blocked by a live write lease on X, on
anything X depends on, and on anything that depends on X. Only the negotiation with readers
is one-way (the readers of X and of everything that depends on X). Stating the reader rule
alone leaves a hole an implementer will faithfully reproduce: nothing would stop a reset of
the database starting while the stack it lives in is still coming up.

Refusal is a contract of the entry points, not only of the core. A refused modifier exits
with one well-known exit code (the reference implementation uses 75) and the negotiation
message, never a stack trace; a new entry point that forgets the handling and crashes with
the default code is a defect, because whatever wraps the script keys its behaviour on that
code.

### The preflight, and convergence to the union

Before any use, an agent checks that the resource is in a state its checkout can work
with. The preflight obeys the same "am I active" decision as the leases: once it can
converge, it is the part of the layer that modifies the resource, so a participant whose
run targets a resource elsewhere must not probe at all, and a CI runner's "one environment
check and nothing else" must include the preflight. For a database that means comparing the migrations the checkout carries with the
ones the resource has applied. The principle behind the outcomes: **a shared tool has one
state, the same for every agent, and agents adapt to it rather than reset it to look like
their own checkout.** Where the work is append-only and ordered (migrations, image tags,
fixture sets), the shared state should converge to the union of every live branch's work,
which is exactly what the main branch will look like once they all merge.

| Resource vs my checkout | Outcome | What happens |
| --- | --- | --- |
| Same | match | proceed |
| Resource lacks some of mine | behind | stop; apply only the missing ones, additively, through the negotiation above. Never a reset |
| Resource has extras from another branch, all of mine applied | ahead | warn and proceed, naming the extras and who applied them, so a failure they cause is attributable |
| Both | behind + ahead | apply the missing ones, then proceed with the warning |
| Applying fails: two branches made incompatible changes | conflict | the one genuine case for a negotiated, serial reset; it means those two branches cannot share this resource until one merges, and the message says so. The conflicting change is its author's to back out on their own branch, never a reset of others' work |
| Resource absent or empty | none | stop; bringing it up is a modifier action |
| The probe itself cannot run | unknown | warn once and proceed. A coordination layer must never be the reason a run fails except by a finding of its own, and a probe that cannot run is not a finding |

A strict mode ("any difference stops") is an explicit opt-in for whoever wants it.

The version of the resource is *derived* from what already exists (the checkout's own
migration list and the resource's own record of what was applied), never kept in a third
place that can drift. After every modifier run the tool writes a derived `state.json`
(what was applied, by which branch, from where, when) so a status command can show "what
is this built from" without touching the resource. It records what the **resource** reports
after the change, never what the participant's checkout declares: on a behind + ahead
convergence those differ, and writing the declaration silently erases the other branch's
work from the one file every other checkout reads. For the same reason the convergence step
captures the underlying tool's own output instead of inheriting its stdio; the conflict
message's entire value is the resource's own words ("column verify_code of relation receipt
already exists"), and a wrapper that inherited stdio would have nothing to say but "command
failed". That `built_by` field is the most
valuable thing in the system: it is what turns "the database does not match" into "built
by branch X in worktree Y at 17:40".

### Environment profiles

Defaults differ by environment. In a developer's `dev` profile a dev server is
interruptible and the grace window for answers is short; in a shared or production-like
profile nothing is interruptible by default and the grace is longer. The profile is a
named set of defaults in a small config file, selected by an environment variable, and
every default it sets can be overridden per lease or per request.

### Interfaces, so the pattern can be adopted anywhere

Implementations differ by operating system, harness and agent platform, so the pattern is
defined as five interfaces, each with at least one implementation:

| Interface | Responsibility | Reference implementation |
| --- | --- | --- |
| `StateStore` | Where leases, requests, state and the graph live | A directory of JSON files under the OS state dir, outside every checkout |
| `Liveness` | Is this holder still alive | `kill(pid, 0)`; a `host` field with clock-based expiry for foreign hosts |
| `ToolAdapter` | Declares a tool's dependencies, actions (reader or modifier), and estimates | One per tool |
| `Probe` | Returns two sorted lists (what the checkout expects, what the resource holds) or unknown | The migrations directory versus the resource's applied list |
| `Notifier` | How a reader learns about a request | The status command; a desktop banner; an agent harness's cross-session messaging; an MCP notification; an A2A task message |

No agent harness or agent-to-agent protocol known to the authors has a shared-resource
lease primitive: A2A negotiates tasks between agents, MCP exposes tools, and neither says
anything about two agents sharing one database. That gap is why this repository exists,
and `Notifier` is where such a platform would plug in.

Two adoption rules ride with the interfaces. First, the message catalogue is a sixth
injected collaborator, not a static import: if the core imports its own wording, an adopter
who wants another language, another tone or another command vocabulary has to fork the
core, which defeats the reason the split exists; injected, the wording is configuration,
and the core's own text carries no resource-specific noun. Second, every on-disk format
carries a version field and every reader checks it, failing closed: an unknown version is
treated exactly like an unparseable file, a live non-interruptible holder reported for a
human to resolve. Two participants at different versions is the normal case for a
machine-global state directory shared by checkouts of different ages.

## Every case, with "light and flexible" applied

| Case | What happens | Who is blocked |
| --- | --- | --- |
| Two agents both run their test suite, same schema | Two read leases, both run | Nobody |
| Agent B wants a reset while A's suite is running | Request posted with a message; A's lease says "test run, ~4 min left, not interruptible"; B waits under `--wait` or exits with the ETA | B, for at most A's ETA, and then only if A is still alive. This is the case that used to corrupt A |
| Agent B's checkout has a migration the resource lacks | Preflight: behind. B applies just the missing one after asking readers, additively | B, briefly |
| The resource has migrations from A's branch that B lacks | Preflight: ahead. B is told which, and by whom, and proceeds | Nobody |
| A and B made incompatible migrations | Preflight: conflict. The only reset case; negotiated and serial, and the message says the branches cannot share until one merges | B, by informed choice |
| `db` reset while a dev server runs | The dev server is on the stack node, which the database depends on; the reset never asks it and proceeds at once | Nobody. Two flat scopes would have stalled here |
| A dev server starts during a `db` reset | The write lease is on a node the dev server does not depend on; it starts immediately | Nobody |
| The stack is stopped while a suite runs | The suite's `db` lease depends on the stack, so it is consulted; the stop waits or exits with the ETA | The stop, correctly: this one really does destroy the run |
| A runtime restart, suite and dev server both live | One request reaches both; the dev server is interruptible so it is notified only; the suite blocks | The restart, until the suite ends or answers |
| Two modifiers at once | The second waits its turn and re-checks when it arrives; if the first did its work, it exits clean | The second modifier, in order |
| A reader arrives during a reset | Told who is resetting, why, and the ETA; waits up to a bound | The reader, for the reset's duration. Honest and unavoidable |
| An agent is killed mid-run | Its lease's pid is dead; ignored and cleaned up by the next command | Nobody |
| The laptop sleeps | Pids survive; leases remain valid; only the estimate goes stale, and a stale estimate never authorises anybody | Nobody |
| A human bypasses the tool with a raw command | Not covered; the scripts are the documented entry points | n/a |
| A CI runner | Fresh machine, no leases, no other users; the layer decides it is not active and does nothing | Nobody, zero cost |
| A gate or pipeline runs tests in its own hidden worktree with no dependencies installed | It takes a read lease like any reader; its probe cannot run, so the preflight is unknown and the suite proceeds; a second session's reset is refused instead of corrupting the run | Only the would-be modifier |
| A second project's suite is running | A different subtree of the graph, never consulted | Nobody |

## What this is not

- **Not isolation.** It coordinates access to one shared resource; it does not give every
  agent its own copy. If genuine parallel modification is needed, give each agent its own
  resource instance. The leases stay useful as the default.
- **Not a queue process or scheduler.** Ordering comes from timestamps on request files;
  nothing runs in the background.
- **Not a security boundary.** Anything that bypasses the entry points bypasses the
  leases. It prevents accidents between cooperating agents, not abuse.

## Decisions taken so far

Recorded from the founder reviews of 2026-08-30. The reviewed design is in
[docs/design-review-2026-08-30.html](docs/design-review-2026-08-30.html) (the original
two-scope version, written for the local-database case) and the review of the first
implementation's HLD/LLD, where most of the refinements below were made, is in
[docs/implementation-review-2026-08-30.html](docs/implementation-review-2026-08-30.html).

1. Readers run concurrently, including two test suites at once. Add an exclusive mode for
   readers only if flakiness is observed. Start permissive, tighten on evidence.
2. The resource's version is derived from what already exists, never a third committed
   file.
3. Silence from a reader means "I need it until my estimate", never consent, and an
   exhausted estimate never authorises a modifier.
4. Readers are notified by a request file and a status command; richer channels are
   `Notifier` implementations, not part of the core.
5. Tools form a dependency graph declared by their adapters, replacing the earlier "machine
   scope / project scope" pair. The container runtime, a project's stack and a project's
   database are three separate tools.
6. Light and flexible is a requirement, not a preference: no daemon, no queue process, no
   scheduler; the happy path is one file write and one check; CI costs nothing.
7. The pattern is tool-agnostic and language-agnostic. It is not tied to any one
   implementation language or package ecosystem, and it should apply to any shared tool or
   resource, on a laptop or in the cloud.
8. The shared state converges to the union of live branches' work. Behind applies
   additively and never resets; ahead warns and proceeds; reset is reserved for a genuine
   conflict. Strict mode is opt-in.
9. Modifiers queue in the order they asked and re-check at their turn; coalescing is per
   tool and decided by that re-check.
10. Requests carry an urgency and a free-text message; leases carry an importance; an
    environment profile sets the defaults.
11. `interruptible` means consent given in advance, withdrawable with *need N*.
12. Readers wait, bounded, only when starting during an active write lease; modifiers
    never wait unless asked to.
13. The layer decides explicitly whether it is active (off when the run targets a resource
    elsewhere, on a known CI provider, or on an explicit disable), and its state directory
    is provably outside every checkout, asserted in code.
14. The pattern is five interfaces with implementations, so operating systems, harnesses
    and agent platforms can each supply their own adapters.

Decisions 15 to 21 were added after building and reviewing the first implementation
(2026-08-30); they are the places the pattern, not that codebase, was under-specified.

15. Exclusivity between modifiers runs in both directions along the graph (a modifier of X
    is blocked by a write lease on X, on its dependencies, and on its dependents); only
    consultation with readers runs one way.
16. The preflight is gated by the same "am I active" decision as the leases, because once
    it can converge it is itself a modifier.
17. The message catalogue is injected into the core as a sixth collaborator, and the
    core's own text carries no resource-specific nouns or commands.
18. On-disk format versions are checked on every read and fail closed, exactly like a
    corrupt file: reported, never silently misread.
19. The convergence step captures the underlying tool's own error text rather than
    inheriting its stdio, and the derived state records what the resource reports, never
    what the participant declares.
20. A request copied into dependent tools belongs to the poster in every copy, and the
    poster clears all of them on every exit path.
21. A refused modifier exits with one well-known code and the negotiation message, never a
    stack; the exit code is a contract of every entry point, not only of the core.

## Status

**First implementation built and reviewed**, as the test bed, in a Node/TypeScript project
with a local Supabase shared by coding agents in git worktrees (three tools: the container
runtime, the project's stack, the project's database). Its HLD and LLD were reviewed on
2026-08-30, the build was reviewed twice against the LLD with every finding fixed and
proven in real processes, and the lessons only the build surfaced are folded into this
README as decisions 15 to 21. Its generic core (leases, requests, graph, FIFO queue,
preflight, injected messages) is the candidate reference implementation for this
repository.

Open questions, in the order they need answering:

1. What is the smallest implementation that lets another person adopt the pattern on
   macOS, Linux and Windows without installing a runtime first? The first implementation
   suggests: the portable pieces are pid liveness, atomic rename and the OS state
   directory; notification is the non-portable piece and must be best-effort; a single
   static binary with the same versioned file formats is the eventual answer for projects
   with no runtime.
2. How does an agent find out about a request mid-task? The first implementation's ranking:
   a status command an agent can be told to run works best; a watch command it can sit on
   is second; a desktop banner reaches a human who is not looking; harness messaging is the
   promising one nobody has built. An agent mid-tool-call cannot be interrupted at all,
   which is why silence must never mean consent.
3. How is the per-project wiring (test-runner hooks, wraps around destructive scripts, a
   dev-server wrap) set up in one command for the common project types?
4. Which resources need a different probe? The database probe generalises to "compare what
   the checkout declares with what the resource reports", which fits a migrations
   directory, a container image tag, a device OS version and a seeded fixture set.
   Anything that cannot produce two sorted lists should declare no probe rather than a
   weak one.

## Licence

MIT.
