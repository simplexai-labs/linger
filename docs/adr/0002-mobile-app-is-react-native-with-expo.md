---
status: accepted
---

# The Mobile App is one React Native codebase built with Expo

The Mobile App ships on iOS and Android and is written and maintained by coding agents, with one person accepting it on real devices. We decided on a single React Native codebase built with Expo, in `apps/mobile`, so each feature is written once and reuses the TypeScript contract types that Web already consumes. Every screen uses native components; no screen wraps web content. Documents and Wiki pages are read-only on the phone and render from their Markdown projection; editing waits for a native editor. Native code is limited to modules for the Bean vendor SDK, audio capture while the screen is locked, the Relay connection, and handing a downloaded file to the system viewer (Quick Look on iOS) for formats the app does not draw itself, such as PDF, video and Office files.

## Considered Options

- **Two native apps, Swift and Kotlin.** Rejected: it adds two more UI codebases beside Web, and every feature is built and accepted twice.
- **A web shell around the existing Web client.** Rejected: the chat screen's keyboard and scrolling would not reach the reference quality, and a web view cannot capture audio while the screen is locked.
