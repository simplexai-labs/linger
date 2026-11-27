---
status: accepted
---

# The Mobile App reaches the user's computer through a forwarding-only Relay

A Linger deployment lives on the user's own computer and listens only on loopback, but the Mobile App has to work away from home. We decided that the computer stays the single source of truth and the Mobile App reaches it through a Relay that only forwards traffic and keeps no product data. The Relay is either the official one or one the user deploys.

## Considered Options

- **Connect the Mobile App to a hosted multi-tenant deployment.** Rejected: the product promise is that the user's data stays on their computer.
- **Replica sync, where every device holds a full copy and a server stores one too.** Rejected: Agents and the database run on the computer, so a phone cannot be a full replica, and two writable copies would need conflict resolution that a single source of truth avoids.

## Consequences

The Mobile App cannot reach Linger while the computer is off, asleep or offline.
