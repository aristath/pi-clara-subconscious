# pi-clara-subconscious

Private thinking for the Pi agent: ongoing topic conversations, independent rest
schedules, and reflections that can return selected context to their originating
chat. A separate coordinator keeps working after the TUI and browser close.

This package does not contain a persona, personal records, a model server, a web
application, or a replacement agent implementation. It loads your configured Pi
resources and uses native Pi sessions, tools, model handling, and compaction.

## Requirements and installation

- Node.js 22.18 or later.
- Pi with the SDK APIs supplied by version 1.5.2 or later. Version 1.5.2 is the
  tested interface. Host packages are peer dependencies, using Pi's required `*`
  ranges rather than shipping duplicate extension runtimes.
- A configured Pi model. Optional memory, web, media, and Presence integrations
  are supplied by separately installed Pi packages.

Clone this repository, then install it as a normal Pi package:

```sh
npm install
pi install .
npm link
pi-clara-subconscious init
```

`npm link` exposes the service command. Alternatively use
`node /path/to/checkout/src/cli.js` in place of `pi-clara-subconscious`.

For an artifact installation, run `npm pack`, install the resulting tarball with
`npm install --global /path/to/pi-clara-subconscious-0.1.0.tgz`, and register the
installed package directory with `pi install /path/to/installed/package`.
There is no npm registry publication implied by these instructions.

Edit the generated configuration before enabling optional tools. Reload Pi after
installing the extension. `/subconscious status` reports the coordinator state;
the extension starts it automatically when a foreground session opens.
`workspace` must name an existing directory.

Start and stop it directly:

```sh
pi-clara-subconscious start
pi-clara-subconscious status
pi-clara-subconscious stop
```

`start` launches a detached process. `serve` runs in the foreground, suitable for
a service manager. `stop` and SIGTERM let the current model/tool step settle and
retain pending work. They do not erase the master pause setting. A subsequent
foreground request or new Pi session can start the coordinator again; idle
heartbeats alone do not restart a deliberately stopped service.

For startup at login and restart after an unexpected process failure, adapt the
user service in [examples/pi-clara-subconscious.service](examples/pi-clara-subconscious.service).
Set its executable path, place it in `~/.config/systemd/user/`, and run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now pi-clara-subconscious.service
```

The supplied unit allows active work to finish during shutdown. On systems
without systemd, use another supervisor with equivalent graceful-stop behavior.

## Configuration

The default file is `~/.config/pi-clara-subconscious/config.json`. Select a
different file with `--config PATH`, or with this setting in Pi's settings.json:

```json
{
  "claraSubconscious": {
    "configPath": "~/.config/pi-clara-subconscious/config.json"
  }
}
```

All participating clients must select the same configuration/data store.

| Field | Meaning |
| --- | --- |
| `dataDir` | Private package state, session transcripts, socket, and service log. Default `./data`, relative to the config file. |
| `workspace` | Pi working directory for general thinking and topics; defaults to the user's home. `init` records the directory where it is run. |
| `agentDir` | Normal Pi agent configuration/packages directory; default `~/.pi/agent`. |
| `initialRestMs` | Initial delay and fallback after a topic/general turn that does not choose a rest; default 300000. Reflections do not use it. |
| `model` | `null` follows Pi's configured foreground default; otherwise `{ "provider": "provider-id", "id": "model-id" }`. |
| `allowedTools` | Exact external tool names; no wildcard permission grants. See below. |
| `additionalExtensionPaths` | Additional trusted Pi extensions, loaded through the standard resource loader. Usually installed Pi packages need no entry here. |
| `errorRetryMs` | Delay before retrying a technically failed conversation; default 30000. Other healthy conversations remain eligible. |
| `heartbeatMs` | Foreground registration interval; default 3000, at least 100. |
| `staleClientMs` | Staleness threshold, default 15000 and at least two heartbeat intervals. |

An example is in [examples/config.json](examples/config.json). Restart the service
and reload foreground Pi sessions after changing package configuration. Existing
Pi model defaults are read again between private turns. Model changes do not
replace transcripts or reset schedules.

Paths support `~` and relative paths. There are no package-specific environment
variables. Unix socket paths have operating-system length limits; use a short
`dataDir`. The service also supports Windows named pipes; the supplied service
unit is Linux-specific.

## Topics and reflections

Each topic has a native Pi session, trusted ownership metadata, and its own
`nextWake`. The general conversation is separate and follows the same rest rules.
Only one private step runs at a time; ready conversations take turns.

Create a user-supplied topic:

```sh
pi-clara-subconscious topic '{"action":"create","title":"Fictional gardens","content":"Explore gardens in imaginary worlds."}'
pi-clara-subconscious list
```

The command returns an ID. `topic` also accepts `list`, `read`, `update`, and
`retire`; use `id` for an existing topic. Users can manage all topics. The agent's
`subconscious_topics` tool can manage only agent-created topics and can read
user-supplied topics. Model-supplied ownership fields cannot override this rule.

During private time the agent has:

| Tool | Purpose |
| --- | --- |
| `subconscious_topics` | List/read topics and manage its own topics. |
| `subconscious_rest` | Choose this topic/general conversation's next rest in milliseconds. |
| `subconscious_source` | Read a reflection's captured originating context. |
| `subconscious_return` | Finish a reflection and queue a selected passage for its source chat. |
| `subconscious_finish` | Finish a reflection silently. |
| `subconscious_start_chat` | Create a separate ordinary Pi session with an assistant opening message. |
| `subconscious_chats` | List/read ordinary Pi sessions, with pagination. |

Zero rest is accepted unchanged. There is no policy minimum. It means another
turn when eligible, with an event-loop yield and the scheduler's 25 ms polling
resolution. A rest begins after the current turn's tools finish; it does not
affect other conversations' schedules. Reflections cannot request rest.

The foreground `subconscious_reflect({content})` tool creates a separate private
session bound to the actual persisted Pi invocation. It is not a topic and is
not merged into one. It continues until explicitly returned or finished, with
no obligation to produce a useful result. Scheduling inputs are extension
messages, not invented human messages.

Returned passages remain pending while the originating session is closed. On
its next run, the extension inserts a hidden custom context entry, without
starting another response. The raw entry is identifiable as an internal
reflection, not a human message. The service acknowledges delivery only after
reading the persisted receipt from the exact source session. Refreshes and
reconnects cannot route it to another open chat or insert it twice. If the source
file or originating branch is unavailable, delivery stays pending.

Starting a new chat is different: it creates a normal Pi session under the
configured Pi session directory, with the selected assistant opening message.
It does not publish the private transcript. A durable notification is exposed
through the API for a host to display, and remains until acknowledged.

## SOUL and configured packages

Private sessions use `DefaultResourceLoader` with the configured Pi workspace,
agent directory, installed packages, and context resources. No identity text is
copied into a separate private identity system.

For `@astrosheep/pi-souls`, a reflection preserves its originating session's
selection metadata. Topic/general thinking follows the foreground default
model's configured SOUL even when private thinking uses a different model.
Only the selection pointer is recorded; the souls package loads the original
document. Other identity extensions load through the same Pi resources.

Use the same workspace/agent configuration as normal chat to load the same
resources. Project trust remains Pi's responsibility. An alternate model must
be available and authenticated through the normal Pi configuration.

Background sessions honor Pi's saved project trust and its `defaultProjectTrust`
policy. They do not present trust dialogs. If a workspace uses project-local
packages/settings, save its trust decision in Pi so background sessions can load
the same resources; a foreground session-only trust choice is not a saved grant.

## Tool permissions and optional integrations

The default allowlist includes ordinary reading/listing/searching, the direct
Songya memory tools, and `presence_read`/`presence_write`. Install and configure
`pi-songya` and `pi-presence` separately when those capabilities are wanted.

For web access and media creation, add the **exact direct tool names** supplied
by your installed packages to `allowedTools`. Names differ between packages;
inspect your normal Pi tool list rather than assuming a particular spelling.
The example leaves these names out until their packages are configured.

An unavailable configured tool appears in `missingTools` in status and in the
private runtime instructions. It does not disable unrelated tools or private
thinking. Credentials/endpoints belong in those packages' private configuration,
not in this repository or this package's examples.

Shell commands, general file editing/writing, generic code execution, tool-search
wrappers, and delegation tools are excluded. Wildcard allowlists and known
unrestricted tool names are rejected. Direct tool calls are checked at execution;
nested/delegated tool execution is blocked, including attempts to reach an
inactive tool. Registered `reachesTools` wrappers cannot be allowed.

Approved memory/media/Presence/topic operations may update their own stores;
that does not grant generic file-writing permission. An allowlisted third-party
tool is trusted to implement its documented capability. Pi extensions themselves
are trusted executable code, not sandboxed plugins; this policy restricts model
tool calls rather than sandboxing installed extension code.

## Foreground priority and host integration

The extension registers foreground sessions with one coordinator per data store.
Input and model-request hooks announce pending/active foreground work. Settled
runs clear the claim. Multiple foreground sessions may run normally; private
work is admitted only when all participating foreground sessions are idle.

If a user message arrives during private generation, that generation finishes.
The foreground request waits for that one step, then receives priority. Pending
private tools and further generations wait until foreground work is idle.
Running tools settle normally. This is boundary-level yielding, not token-level
suspension or cancellation. The package does not require a special model router.

Private sessions disable their own cache warming so it cannot bypass scheduling;
the foreground's cache-warming setting is unchanged.

The public `Client` API uses a local socket, protected by user-only directory
and socket permissions. A host that bypasses Pi's normal input/provider hooks
must explicitly announce activity:

```js
import { Client } from 'pi-clara-subconscious/client';

const client = await new Client('/path/to/private/config.json').connect();
const registration = {
  id: 'host-instance-session-id',
  pid: process.pid,
  file: session.sessionManager.getSessionFile(),
  sessionId: session.sessionManager.getSessionId(),
};

await client.call('foreground.enter', registration, { timeout: 0 });
try {
  await session.prompt('A user request');
} finally {
  await client.call('foreground.update', { ...registration, busy: false });
}
// On host/session shutdown:
await client.call('foreground.leave', { id: registration.id });
```

Keep `foreground.update` heartbeats running during long requests. SDK hosts must
bind Pi extensions with `session.bindExtensions(...)` and emit the normal
`session_shutdown` lifecycle event before disposing/replacing a session. Hosts
must preserve the same registration ID while a session is active.

Stale registrations whose processes have died are removed. A stale **live**
process retains its busy claim because it may still be generating. Status shows
stale clients; after verifying that a host is no longer working, explicitly
unregister it. An unreachable coordinator is reported to the foreground; normal
user chat remains usable. Cross-client priority applies to clients connected
to this coordinator, not unrelated Pi processes without this extension/hook.

## Inspection and control

In Pi:

```text
/subconscious status
/subconscious pause
/subconscious resume
/subconscious list
/subconscious read <conversation-id> [offset]
/subconscious topic {"action":"list"}
/subconscious actions
/subconscious notifications
```

The same operations are available through the CLI and `Client.call`:

| Method | Parameters/result |
| --- | --- |
| `ping` | Service PID/store identity and shutdown status, without conversation contents. |
| `status` | Pause, active step, clients, conversations, unavailable integrations, and errors. |
| `pause` | `{paused: true/false}`; persists without discarding any work. |
| `list` | All private conversations, including finished/retired ones. |
| `read` | `{id, offset?, limit?}`; metadata and raw Pi entries, preserving thinking, calls, results, and image content. Maximum page size 100. |
| `topic` | User topic management; `{action, id?, title?, content?, receipt?}`. Reuse a receipt for a retried mutation. |
| `actions` | Started tool invocations, recorded arguments, and `active`/`resolvable` flags. Running actions cannot be resolved. |
| `resolve` | Explicitly settle an inspected unknown tool outcome; see recovery. |
| `notifications` | Durable new-chat notifications with IDs and ordinary Pi session files. |
| `notification.ack` | `{id}` after a host has handled a notification. Hosts should deduplicate using the ID. |
| `foreground.enter/update/leave` | Host activity integration described above. |
| `deliveries` | `{clientId}`; only that registered source session's pending reflections, acknowledging receipts already persisted by Pi. |
| `reflection.create` | `{clientId, callId}`; validates the actual persisted `subconscious_reflect` invocation and derives its thought/source from Pi. |
| `stop` | Graceful service shutdown. |

For example, `pi-clara-subconscious read ID 30` reads another transcript page.
`unregister CLIENT_ID` removes a verified stale host. `ack ID` acknowledges a
new-chat notification. Inspection commands do not trigger model responses.

## Storage and recovery

`dataDir` contains:

- `state.json`: ownership, schedules, pause, invocation receipts, accepted work,
  pending deliveries, and tool outcomes. Atomic replacement and fsync protect
  accepted package mutations.
- `sessions/`: native Pi private transcripts, tagged with a custom private marker.
- `service.sock`, `service.lock/`, and `service.log`: local service operation.

These are private runtime data. They are never package artifacts. Directories
and new state files are created with user-only permissions. Do not put `dataDir`
inside a public repository. The public package `.gitignore` excludes common
local state files, but custom runtime locations remain your responsibility.

A single owner lock prevents two coordinators from scheduling one store.
Restarting the service recovers completed turns and recorded tool results before
issuing further model work. Package-owned operations carry transaction receipts;
new-chat creation also persists its destination before writing it.

Pi does not expose a public API for resuming an interrupted tool batch. Calls
never admitted before shutdown receive truthful "not executed" tool results;
the model can request them again. Known completed calls recover their recorded
results without executing again. An externally acting tool interrupted after
admission has an **unknown outcome**: that conversation is retained and blocked,
while others remain eligible. Do not blindly repeat the action.

Inspect its real result, then settle it explicitly:

```sh
pi-clara-subconscious actions
pi-clara-subconscious resolve '{"key":"RECEIPT_FROM_ACTIONS","executed":false}'
```

Use `executed:false` only after verifying it did not execute. For an observed
successful action, supply the actual result instead:

```json
{
  "key": "RECEIPT_FROM_ACTIONS",
  "executed": true,
  "result": {
    "content": [{"type":"text","text":"Observed result from the original action."}],
    "isError": false
  }
}
```

No tool is re-executed by `resolve`; it records the observed result and unblocks
the conversation. Private transcripts and pending deliveries survive master pause
and service restarts. There is no automatic SOUL revision, agenda processing, or
other behavior inherited from an older application.

## Development

```sh
npm ci
npm test
npm pack
```

Tests use synthetic records, controlled providers/tools, temporary configuration,
and real Pi SDK sessions. They do not call live inference or production services.
They cover scheduling, permissions, yielding, delivery, restart recovery, normal
package loading, clean artifact installation, and detached service operation.

Licensed under [MIT](LICENSE).
