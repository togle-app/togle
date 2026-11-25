# Reach: Togle across your devices

Reach is the development name for Togle Pro’s hosted device connection. The Togle client pairs devices and checks which actions each may take. The relay checks the account entitlement and carries messages encrypted between the devices. The planned phone client is the open-source Togle app. The separate Studio desktop app handles call audio.

**Status: not reviewed.** Reach stays out of every release until an outside review has tried to break it. Only a development run with a courier set (`TOGLE_COURIER`) has it. A packaged Togle never does. Togle account sign-in and the Pro waitlist work independently of the courier.

## What is built

- **Your devices** (Settings → Devices). In the development client, sign in under Settings → Accounts → Togle account, then choose **Connect this computer** in Devices to start a group. Pair later devices by entering the new device’s code at a computer you already trust and confirming its name and role. **Remove** revokes a device. **Other devices may act on this computer** controls whether it accepts remote actions.
- **Tasks on your other computers** (Agents). Each computer's tasks show under its name, with a command it waits on in full. From here you can **Refuse** that command or **Stop** the task. Allowing it from another device will need your fingerprint, face or PIN, and that is not built yet, so for now a command is allowed on its own computer.
- **A record** (Settings → Devices): what other devices did on this computer, and a system notice each time.

Not built yet: Allow and Start from another device (with Windows Hello, Touch ID or a phone's face or fingerprint), keys kept in the computer's security chip, **Stop all**, the to-do list and notes shared between devices, Togle for a server (the connector), and the phone app.

## How it works

The parts are in `src/main/reach/`:

| File | What it does |
| --- | --- |
| `crypto.ts` | Each device's keys (Ed25519 to sign, X25519 to agree on locks), CPace for codes, AES-256-GCM locks per pair of devices, passes, and proofs for an Allow |
| `book.ts` | The list of your devices each device keeps and checks: a pass counts only when a computer of your devices signed it, for a week, and a removal only when a computer did |
| `pairing.ts` | Adding a device by its code, on both sides |
| `link.ts` | The connection to the courier: hello with this device's public keys, a signed challenge, and trying again after a drop |
| `reach.ts` | All of it together: signing in, codes, adding and removing, what passes between devices, and acting on a task |
| `share.ts` | What a computer tells your other devices about its tasks: the least they need, with text that looks like a key or a password hidden (the command is sent whole: it is what runs) |
| `studio-account.ts` | Signing in to a Togle account with a code sent by email |

**Adding a device.** The new device asks the courier for a room and shows an 8-letter code: the room's two letters, then six secret ones that never reach the courier. You type the code at a computer, which joins the room. The two run CPace on the code through the room and each proves it got the same key before anything else is said. The courier carries every word and can't try codes, and one wrong code ends the exchange (the new device then shows a new code by itself). Locked with that key, the new device says who it is; the computer shows you, and on your yes signs its pass and sends the list of your devices.

**Between devices.** Every message is locked for one other device with the pair's key and says who it is from and for, so the courier can't read it, change it or send it to another device. A device takes a message only from a device whose pass holds. A server is never told about your other servers, and never sees another device's tasks. An act from another device counts only within two minutes of being made, and only once. The device that runs the task checks it: the sender's role, that Togle runs the task, that the request still waits.

**Removal.** A removed device is told at once if it is online, and the removal travels with the list of your devices to the others, signed by the computer that removed it. A device removed while it was off learns it the next time it connects. A removed phone or server can't renew its pass, so it runs out within a week everywhere.

## The courier's messages

The messages between Togle and the courier are in [`src/shared/courier-protocol.ts`](../src/shared/courier-protocol.ts). The hosted Togle Pro service uses that public format. Other implementations can use it too. Each destination device verifies the message and decides whether the action may run.

## Tests

- `test/reach-crypto.test.mjs`: keys, codes, locks, passes and proofs.
- `test/reach-book.test.mjs`: the list of devices, adding by code (a wrong code, out of order, tampered), and what is shared about a task.
- `test/reach-service.test.mjs`: three devices through a stand-in courier (`test/fake-courier.mjs`): the first signs in, a computer and a server are added, a wrong code adds nothing, tasks reach the other computer and not the server, Refuse and Stop from there, removal (online and while off), the courier dropping everyone, starting again, the sign-in to Studio and the connection.
- `test/tasks-ui.cjs` (`npm run test:tasks:ui`): another device's tasks in Agents, Refuse and Stop, and Settings → Devices.

`scripts/profile.cjs` runs Togle with a data folder of its own, to try two Togles on one computer.
