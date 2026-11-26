# Togle device connection

The MIT-licensed Togle desktop Reach code supplies the device identity, pairing, signed device list and encrypted messages. The React Native adapters use the phone’s secure random source and WebSocket, Noble’s cryptographic primitives and native secure storage supplied by the app. `scripts/configure.mjs` builds the phone client using the wire types and constants shared with [Togle desktop](../../src/shared/courier-protocol.ts).

The phone sends its Togle account token when proving its device key. The managing computer creates an invitation. The phone uses the scanned or pasted room identifier to meet the computer at the relay, and the two devices run CPace with the secret from the invitation. The managing computer approves the new phone and sends a signed membership list over the resulting encrypted channel. The older short-code flow remains available. The core accepts a reply only for a currently shared Codex choice and waits for the host’s acknowledgment.
