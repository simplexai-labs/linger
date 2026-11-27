---
status: accepted
---

# The Mobile App and the computer encrypt their session themselves; the Relay only joins two connections

The Relay must not be able to read what passes between the Mobile App and the user's computer, and the same Mobile App must also reach the computer directly on the local network. We decided that the two ends run one end-to-end encrypted session of our own protocol, in the style of Orca: the computer holds a long-lived key, the pairing QR code carries its public key, and the Mobile App accepts only that key. The Relay joins the Mobile App's connection to an outbound connection from the computer and forwards opaque frames. The same session runs unchanged over a direct local-network connection. The handshake is `Noise_XK_25519_ChaChaPoly_SHA256` instead of a hand-built key exchange: the phone sends its key and its first application data only after two forward-secret messages, a later leak of the computer's key does not expose recorded traffic, and the code can be checked against a public specification. A pairing invite travels only inside that handshake, and the Human approves a new phone on the computer after comparing a code both screens show, so a photographed QR code cannot pair a stranger's phone.

## Considered Options

- **Standard HTTPS with the Relay routing by hostname and the computer terminating TLS.** Rejected: every computer needs a public hostname and a certificate issued through an official service, which that service could misuse, and a direct local-network connection would need its own certificate story.
- **An embedded peer-to-peer library.** Rejected: its React Native bindings are not mature, and it adds a second transport to debug.

## Consequences

The protocol is security-critical code that we own. It is reviewed by a person before it ships and verified on real devices.
