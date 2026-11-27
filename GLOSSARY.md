# Linger

Linger is a personal agent that runs on the user's own computer. This glossary fixes the words the product and the code use for its concepts.

## Language

### Clients

**Mobile App**:
The Linger client for phones, on iOS and Android. Together with Web and Desktop it is one of the three clients of a deployment.
_Avoid_: phone client, app, native app

**Relay**:
A service between the Mobile App and the user's computer that forwards their traffic and keeps no product data. Linger runs an official Relay, and a user can run their own. The Local MCP Relay is a different thing and always carries its full name.
_Avoid_: sync server, tunnel, proxy, cloud

**Pairing**:
The one-time act that lets one Mobile App reach one computer: the user scans a code that Desktop shows. A Paired Phone can be removed on the computer without affecting the others.
_Avoid_: login, binding, linking, enrollment (that word belongs to a Local Computer)

### Voice hardware

**Bean**:
The wearable microphone made for Linger. It sends the wearer's live speech to the Mobile App.
_Avoid_: recorder, hardware, device, recording bean
