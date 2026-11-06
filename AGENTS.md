# agent-leases agent memory

- Start with `README.md`. The "What this package does" table is the contract for this repo. Later sections describe the design, including behavior that is not implemented.
- `expectedUntil` is an estimate. Do not expire or override a live holder because it passed. Silence is not consent.
- Unreadable, unknown-version, or invalid holder records block acquisition and are kept. Only proven local death may remove a holder.
- The store is one Linux host and one PID namespace. A flat resource string is not a dependency graph.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
