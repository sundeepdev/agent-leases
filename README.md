# agent-leases

A pattern for many autonomous agents sharing one resource on a laptop or in the cloud,
so that no agent modifies the resource while another agent's run depends on it.

The resource can be anything several agents reach at once and one of them sometimes has
to change: a local database, a Docker stack, a dev server, a device, an emulator, a
shared cache, a staging environment. The pattern was worked out for a local Supabase
shared by several coding agents in git worktrees, where worktrees isolate files but not
the database. It is written here without that specificity so it can be applied to any
shared thing.

This repository holds the pattern, its rationale and the decisions behind it. A reference
implementation is planned and will live here too; see [Status](#status).

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
says who they are, what they are doing, and how long they expect to need it. A modifier
that wants to change the resource looks at the live leases, posts a *request* saying what
it wants and for how long, and the readers get a say: *go ahead*, *I need N more minutes*,
or silence, which is never treated as consent. The modifier then waits, or exits with a
clear "busy, here is who and until when" that a calling agent can act on. Before any use,
each agent runs a cheap *preflight* that checks the resource is in the state its checkout
expects, and stops with a plain message when it is not.

No daemon, no queue, no scheduler. State is a directory of small files. The happy path is
one file write and one check.

## The model

### Readers and modifiers

| | Readers | Modifiers |
| --- | --- | --- |
| What they do | Use the resource as intended: run tests against it, query it, serve from it | Change its shape or availability: reset, restart, migrate, rebuild, stop |
| How many at once | Any number | One, and only when no live reader objects |
| What they hold | A **read lease** | A **write lease** |
| When they wait | Only while a write lease is active (a reset in progress) | While any live read lease has not consented |

### The lease

A lease is a small file in a shared state directory outside every checkout. It records:

- `pid` (or an equivalent liveness handle), so a dead holder can be detected and ignored
- `kind`: read or write
- `purpose`: what the holder is doing, in words a human can read in a refusal message
- `where`: the checkout, branch, or session it belongs to
- `started_at` and `expected_until`: an honest estimate, so others can plan around it
- `interruptible`: whether the holder can be sacrificed (an unattended test run cannot
  answer for itself and is not interruptible; an ad-hoc shell session usually is)
- a random `token`, so only the holder can release its own lease

Leases are released on normal exit and on signals. A holder that dies without releasing
leaves a file whose pid is dead; the next check ignores it and cleans it up. There is no
manual cleanup in the normal case, and a `--force` for the abnormal one.

### The request, and the three answers

When a modifier finds live read leases, it posts a *request* file: what it wants (reset,
restart, migrate), its own estimate, and who it is. Readers are told through whatever
channels the environment has (a desktop notification, a status command, a watch command an
agent can sit on). A reader answers in one of three ways:

| Answer | Meaning |
| --- | --- |
| **ok** | Go ahead now. I am done, or my run can be sacrificed and re-run. |
| **need N** | Wait; I need about N more minutes. Extends my `expected_until`. |
| **silence** | Treated as "I need it until my `expected_until`". Never as consent. |

Silence is the important one. Most readers are unattended runs that cannot respond, and
the whole point is that they are not destroyed. Their estimate speaks for them.

The modifier then:

- proceeds, if every live reader said ok or every read lease is stale;
- waits, under a `--wait` flag, until the leases are gone or answered ok;
- otherwise exits with a distinct "temporarily unavailable" code and a message naming the
  holders, their purposes and the earliest time it could proceed, so the calling agent can
  choose to wait, do something else, or escalate to a human.

### Scopes

Some modifications affect one project's resource; some affect everything on the machine.
A Docker restart touches every project's containers; a schema reset touches one
database. So leases and requests carry a *scope*, and the state directory has one
subdirectory per project plus one for the machine:

```
<state>/
  _machine/            scope: machine   (restart the container runtime, stop everything)
    leases/ requests/
  <project-id>/        scope: project   (reset, migrate, restart this project's resource)
    leases/ requests/ state.json
```

A project-scope modifier consults only its project's leases. A machine-scope modifier
consults every project's leases and posts its request into each project's `requests/`, so
each project's readers hear about it through their own channel. Readers register under
their project and are invisible to other projects, which is the point.

### The preflight

Before any use, an agent checks that the resource is in the state its checkout expects.
For a database that means comparing the migrations the checkout carries with the ones the
database has applied. The four outcomes, and what a reader does:

| Resource vs my checkout | Outcome | Reader does |
| --- | --- | --- |
| Same | match | proceeds |
| Resource lacks some of mine | behind | stops; applying them is a modifier action, taken through the negotiation above |
| Resource has some I lack (built by another branch) | foreign | stops and names who built it; the agent chooses to rebuild (negotiated) or wait |
| Resource absent or empty | none | stops; bringing it up is a modifier action |

The version of the resource is *derived* from what already exists (the checkout's own
migration list and the resource's own record of what was applied), never kept in a third
place that can drift. After every modifier run the tool writes a derived `state.json` (what
was applied, by which branch, from where, when) so a status command can show "what is this
built from" without touching the resource.

## Every case, with "light and flexible" applied

| Case | What happens | Who is blocked |
| --- | --- | --- |
| Two agents both run their test suite, same schema | Two read leases, both run | Nobody |
| Agent B wants a reset while A's suite is running | Request posted; A's lease says "test run, ~4 min left, not interruptible"; B waits under `--wait` or exits with the ETA | B, for at most A's ETA. This is the case that used to corrupt A |
| Agent B's checkout has different migrations | Preflight: foreign. Clear message naming A's branch. B chooses reset (negotiated) or waits | B, by its own informed choice, instead of failing mysteriously |
| Agent B has one migration the resource lacks | Preflight: behind. A non-destructive "apply missing" is the modifier action, usually consented at once | B, briefly |
| A reader arrives during a reset | Told who is resetting and the ETA; can `--wait` | The reader, for the reset's duration. Honest and unavoidable |
| An agent is killed mid-run | Its lease's pid is dead; ignored and cleaned up by the next command | Nobody |
| The laptop sleeps | Pids survive; leases remain valid; only the ETA estimate is stale | Nobody |
| A human bypasses the tool with a raw command | Not covered; the scripts are the documented entry points | n/a |
| A CI runner | Fresh machine, no leases, no other users; the tool sees an empty state dir and does nothing | Nobody, zero cost |
| A gate or pipeline runs tests in its own hidden worktree | It takes a read lease like any reader; a second session that tries to reset is refused instead of corrupting the run | Only the would-be modifier |

## What this is not

- **Not isolation.** It coordinates access to one shared resource; it does not give every
  agent its own copy. If genuine parallel modification is needed, give each agent its own
  resource instance. The leases stay useful as the default.
- **Not a queue or scheduler.** Two modifiers waiting on the same readers race when the
  leases clear. Fine for one machine and a handful of agents.
- **Not a security boundary.** Anything that bypasses the entry points bypasses the
  leases. It prevents accidents between cooperating agents, not abuse.

## Decisions taken so far

Recorded from the founder review of 2026-08-30 (the full reviewed design, with diagrams,
is in [docs/design-review-2026-08-30.html](docs/design-review-2026-08-30.html); it is
written for the local-database case and is the worked example behind this README).

1. Readers run concurrently, including two test suites at once. Add an exclusive mode for
   readers only if flakiness is observed. Start permissive, tighten on evidence.
2. The resource's version is derived from what already exists, never a third committed
   file.
3. Silence from a reader means "I need it until my estimate", never consent.
4. Readers are notified by a request file, a desktop banner, a status command and an
   optional watch command; no daemon.
5. Docker and container runtimes are laptop-level; a schema change is project-level. Two
   scopes, one state directory.
6. Light and flexible is a requirement, not a preference: no daemon, no queue, no scheduler;
   the happy path is one file write and one check; CI costs nothing.
7. The pattern is tool-agnostic and language-agnostic. It is not tied to any one
   implementation language or package ecosystem, and it should apply to any shared tool or
   resource, on a laptop or in the cloud.

## Status

Pattern documented; implementation not started. The first implementation target is a
local Supabase shared by coding agents in git worktrees (the case this was designed for).
Open questions for the next session, in the order they need answering:

1. What is the smallest implementation that lets another person adopt the pattern on
   macOS, Linux and Windows without installing a runtime first?
2. How does an agent *find out* about a request when it is mid-task: which channels work
   for which harnesses (desktop notification, a file it polls, a watch command it sits on,
   a message between sessions)?
3. How is the per-project wiring (test-runner hooks, script entry points) set up in one
   command for the common project types?
4. Which resources beyond a database need a different preflight, and what is the minimal
   configurable "probe" that covers them?

## Licence

MIT.
