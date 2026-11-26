# Reach: Togle across your devices

Reach is the development name for Togle Pro’s hosted device connection. The Togle client pairs devices and checks which actions each may take. The relay checks the account entitlement and carries messages encrypted between the devices. The Android pilot uses the Togle mobile app. The separate Studio desktop app handles call audio.

**Status: not reviewed.** Reach stays out of every release until an outside review has tried to break it. Only a development run with a courier set (`TOGLE_COURIER`) has it. A packaged Togle never does. Togle account sign-in and the Pro waitlist work independently of the courier.

## What is built

- **Your devices** in Settings → Devices. Sign in and choose **Enable remote access** on the computer you want to manage the group. Choose **Show QR code** for a phone, or **Enter a code** for another computer or server. Confirm the device’s name and role on the managing computer. **Remove** revokes the device. **Other devices may act on this computer** controls whether it accepts remote actions.
- **Recovery.** Choose **Copy recovery key** on the managing computer and paste the key into your password manager. On a replacement computer, choose **Use recovery key** and paste it there. Save the new key after recovery and pair the devices you still use.
- **Agents across devices.** **This computer** comes first. Each paired computer and server has its own foldable section, including an offline device or one with no recent tasks. Open a task to see its reported state and current request. Paired computers can **Refuse** a command or **Stop** a managed task when the host allows it. Command approval takes place on the computer running the task.
- **A record** (Settings → Devices): what other devices did on this computer, and a system notice each time.

The release roadmap includes remote approval and starting tasks with presence verification, earlier conversation history and desktop follow-ups, synced to-dos and notes, a server connector and the public mobile app.

## Private device control pilot

Run the desktop host from source with a fresh Togle profile, a local development courier and an account with pilot access. Configure these variables before starting Electron.

| Variable | Value |
| --- | --- |
| `TOGLE_COURIER` | Local pilot courier WebSocket URL |
| `TOGLE_ACCOUNT_SUPABASE_URL`, `TOGLE_ACCOUNT_SUPABASE_KEY` | Local pilot account URL and public client key |
| `TOGLE_PHONE_PILOT` | `1` to let a paired computer or phone select a listed Codex answer |
| `TOGLE_PHONE_PILOT_FOLDER` | Full path to a new temporary demo folder. Start the test task in this exact folder to share it. |
| `TOGLE_PHONE_PILOT_ACTIVITY` | `1` to let a paired pilot phone open recent activity and usage for managed sessions in the configured folder |
| `TOGLE_PILOT_ACCOUNT_USAGE` | `1` to also share provider-wide totals and account limits with paired controllers |
| `TOGLE_PHONE_PILOT_MESSAGES` | `1` to enable the phone’s composer, queue controls and Stop for eligible sessions in that folder |
| `TOGLE_DESKTOP_PILOT_ACTIVITY` | `1` to share the latest conversation, model and session usage from that folder with paired computers |
| `TOGLE_GENUINE_QUESTION_SMOKE` | `1` to enable the Codex input tool on new threads for this test |

Sign in under **Settings → Accounts → Togle account**. In **Settings → Devices**, choose **Enable remote access** and confirm on the computer. Choose **Show QR code** and scan it from the phone after signing in there. Confirm the phone’s name and role on the computer. Enable **Other devices may act on this computer**.

Start a Codex task in the demo folder. Ask it to offer **Which color should I print?** with **Blue** and **Green**, then print the chosen color. Open the task from **Agents** on another paired computer, or open the question on the paired Android pilot. Select **Green** and verify the result on the host. Each computer can host and answer in the same group. To try the reverse direction, configure the same development pilot settings on the second computer and start a task there.

Both controllers send the option index, task key and current request ID in an encrypted action. The host checks the caller, its permissions and the live request before accepting an answer. A question gets a fresh ID on each occurrence and accepts a single answer. Android receives the eligible question and its title from the configured workspace. Desktop also sees shared task status and supported controls.

With activity sharing enabled, the phone lists recent managed sessions in the configured folder and fetches their model, messages, work counts and session usage as you open them. The report leaves out separate command and file entries and hides common secret patterns from conversation text. With `TOGLE_PILOT_ACCOUNT_USAGE=1`, Agent usage also shows the host's provider totals and account limits across folders. The host can continue sharing these read-only reports with remote actions turned off.

Enable message sharing alongside activity sharing to try the composer. The desktop records messages in the same task conversation. When the task is waiting for an answer or the agent needs to finish its turn, the message goes into the desktop’s queue. The phone can remove queued messages and send them when the task is ready. The desktop’s remote-actions setting governs these controls.

With desktop activity enabled on a host, open one of its managed tasks under **Agents** on a paired computer. The conversation opens with its model and session usage. Account-wide limits follow the host’s account-usage setting. It refreshes while it is open. The view is available when remote actions are turned off on the host. Enable desktop activity on each pilot computer that should share its conversation.

## How it works

The parts are in `src/main/reach/`:

| File | What it does |
| --- | --- |
| `crypto.ts` | Each device's keys (Ed25519 to sign, X25519 to agree on locks), CPace for codes, AES-256-GCM locks per pair of devices, passes, and proofs for an Allow |
| `book.ts` | The list of your devices each device keeps and checks: the managing computer signs week-long passes and revocations, and each device verifies its pinned signing key |
| `pairing.ts` | The authenticated exchange for a QR invitation or typed code |
| `recovery.ts` | Recovery key creation and proof of possession for a specific replacement computer |
| `link.ts` | The connection to the courier: hello with this device's public keys, a signed challenge, and trying again after a drop |
| `reach.ts` | All of it together: signing in, codes, adding and removing, what passes between devices, and acting on a task |
| `share.ts` | What a computer tells your other devices about its tasks: the least they need, with recognized credentials hidden and sensitive commands kept on their host |
| `studio-account.ts` | Signing in to a Togle account with a code sent by email |

**Adding a device.** The managing computer creates a one-time invitation containing a room identifier and a secret for the phone. Scan the QR code in Togle on the phone or copy the invitation and paste it into Togle on your own phone. For another desktop or server, enter the short code it shows. The devices verify possession of the pairing secret through CPace. The relay receives only the room identifier and carries the exchange. The managing computer shows the device’s name and role before signing it in.

**Between devices.** Every message is locked for one other device with the pair's key and says who it is from and for, so the courier can't read it, change it or send it to another device. A device takes a message only from a device whose pass holds. A server is never told about your other servers, and never sees another device's tasks. An act from another device counts only within two minutes of being made, and only once. The device that runs the task checks it: the sender's role, that Togle runs the task, that the request still waits.

**First setup and recovery.** Each managing computer proves possession of its own key and creates an isolated group. One Togle account supplies Pro access to multiple groups. Account access alone does not grant any device’s permissions or reserve a first-computer slot. The managing computer can add devices, and paired devices can use the agent controls each host enables. Recovery proves possession of the saved key for the old group and binds the proof to the replacement’s fresh challenge and new recovery public key. The relay replaces only that group atomically. The saved old key expires when recovery succeeds.

**Local confirmation.** The development build prompts for Touch ID on supported Macs. Windows, Linux, and Macs without Touch ID use a native consent dialog in the development pilot. That dialog confirms intent in the active desktop session. Operating-system user verification on those platforms remains future work.

**Limits.** Remote actions require a current relay membership check at dispatch. Long-lived device keys provide no forward secrecy. Compromising an authorized endpoint exposes whatever that endpoint can access. Independent review is still required before public release.

**Removal.** A removed device is told at once if it is online, and the removal travels with the list of your devices to the others, signed by the computer that removed it. A device removed while it was off learns it the next time it connects. A removed phone or server can't renew its pass, so it runs out within a week everywhere.

## The courier's messages

The messages between Togle and the courier are in [`src/shared/courier-protocol.ts`](../src/shared/courier-protocol.ts). The hosted Togle Pro service uses that public format. Other implementations can use it too. Each destination device verifies the message and decides whether the action may run.

## Tests

- `test/reach-crypto.test.mjs`: keys, codes, locks, passes and proofs.
- `test/reach-book.test.mjs`: the list of devices, adding by code (a wrong code, out of order, tampered), and what is shared about a task.
- `test/reach-service.test.mjs`: three devices through a stand-in courier (`test/fake-courier.mjs`): group enrollment and isolation, typed pairing, task sharing, Refuse and Stop, revocation, reconnects, and recovery key rotation.
- `test/tasks-ui.cjs` (`npm run test:tasks:ui`): another device's tasks in Agents, Refuse and Stop, and Settings → Devices.

`scripts/profile.cjs` runs Togle with a data folder of its own, to try two Togles on one computer.
