---
status: accepted
---

# The computer links to every Relay node and the phone picks one

One Relay cannot be fast everywhere. From mainland China the overseas Relay
costs about 860 ms per request, while a mainland node answers in about 40 ms;
abroad it is the other way round. A phone can only reach the computer through
a node the computer is linked to, and the phone moves while the computer does
not. We decided that the computer keeps one link to every enabled node in a
list it stores, and the phone chooses among them: it races every node, keeps
the first handshake and tries the fastest one it measured first next time, or
it uses only a node the Human pinned.

The list holds the official nodes (one abroad, one in mainland China) and any
custom nodes the Human adds from the phone or from Settings › Phones on the
computer. Official nodes can be turned off but not removed. The pairing code
and every welcome carry the list, so a paired phone learns a new node on its
next session without pairing again.

## Considered Options

- **The phone tells the computer which node to link to.** Rejected: the phone
  needs a session to say so, and the node it wants is the one it cannot reach
  yet.
- **One node chosen on the computer.** Rejected: the right node depends on
  where the phone is, which the computer cannot know.
- **A domain with TLS for the mainland node.** Deferred: a mainland domain needs
  a filing. The node serves plain `ws://` on an IP address instead, which is
  safe because ADR 0003's Noise session encrypts everything end to end and the
  phone pins the computer's key.

## Consequences

The computer holds a few idle links, one per node. Each node sees the
computer's Host ID and connection timing, as ADR 0003 already accepts for one
Relay. A plain `ws://` node also shows that timing to the networks in between.
The Push Service stays on the official overseas node only.
