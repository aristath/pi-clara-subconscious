# pi-clara-subconscious

Clara’s scheduled tasks and chat-triggered private reflections, using native Pi
sessions and the user’s existing SOUL, settings, model, and tools.

## Scheduled tasks

The Clara application owns **one shared scheduler for all users**. It reads
`tasks/*.js` and `tasks/*.ts` inside each user’s profile, runs one due task at a
time, and gives frontend chats priority between calls. Scheduled tasks do not
need a separate service or a per-user scheduler.

[The scheduled-tasks skill](skills/tasks/SKILL.md) is the complete authoring guide:
file headers, intervals, deterministic code, inference prompts, fresh/continuing
sessions, editing and removing tasks, and stored progress. Pi discovers this skill
when the package is installed. No real tasks are supplied or installed.

A minimal deterministic task:

```js
/**
 * @every 5 minutes
 * @mode deterministic
 */
export default async ({ user }) => {
  const { writeFile } = await import('node:fs/promises');
  await writeFile('tasks/example.txt', `Hello from ${user}\n`);
};
```

A continuing inference task:

```js
/**
 * @every 13h
 * @mode inference
 * @session continue
 */
export default 'Continue the work described in this task’s notebook.';
```

Intervals include calendar months, such as `@every 6 months`. Inference defaults
to `@session fresh` unless the definition says `continue`.

The host application uses `TaskScheduler` from `src/tasks.js` and `runTask` from
`src/task-runner.js`. Its foreground admission uses the scheduler’s existing
`Gate`. Task execution happens in a separate process with the owner’s cwd and Pi
runtime. A task worker holds the existing process lock while it runs.

## Install

Requires Linux, Node.js 22.18+, and Pi 1.5.2+.

```sh
git clone <repository-url>
cd pi-clara-subconscious
npm install
pi install .
```

Clara’s deployment uses this editable Git checkout. Private task files, user
configuration, credentials, state, and generated files belong outside the repo.

## Chat-triggered reflections

The existing per-user coordinator continues to handle thoughts set aside from a
frontend chat with `subconscious_reflect`. Reflections keep their exact source
conversation and can return selected context there with `subconscious_return`,
or end silently with `subconscious_finish`. They do not automatically prompt the
frontend. The coordinator no longer wakes an empty general conversation on a timer.

Private reflection tools also include `subconscious_source`,
`subconscious_start_chat`, and `subconscious_chats`. The existing model/tool gate,
accepted-action recovery, and transcript inspection remain in use for reflections.

### Configuration

Use the `claraSubconscious` section of the profile’s `.pi/settings.json`:

```json
{
  "claraSubconscious": {
    "dataDir": "./subconscious",
    "initiallyPaused": true,
    "model": null
  }
}
```

`dataDir` resolves from the profile directory. The native Pi agent directory
supplies package configuration. `model: null` follows the profile’s default;
otherwise use `{ "provider": "provider-id", "id": "model-id" }`.
`allowedTools` contains exact permitted private tool names. General execution and
delegation are excluded; a trusted host factory supplies guarded file tools.

The current heartbeat, stale-client, and error-retry options remain available as
`heartbeatMs` (3000), `staleClientMs` (15000), and `errorRetryMs` (30000).

Run the reflection coordinator from the owner’s profile directory:

```sh
node /path/to/pi-clara-subconscious/src/cli.js serve --config .pi/settings.json
```

An embedding host can supply its trusted `--agent-dir` and `--factory` arguments.
The supplied [systemd unit](examples/pi-clara-subconscious.service) allows a
current call to finish during shutdown. Use an equivalent supervisor when systemd
is unavailable.

### Controls

`/subconscious status`, `pause`, `resume`, `list`, `read <id>`, `actions`,
`resolve <JSON>`, and `notifications` use the existing coordinator. The CLI
supports the same commands, plus `start`, `serve`, `stop`, and `init`.

Pause is durable and lets the current call finish. It controls chat-triggered
reflections; the shared scheduled-task queue is configured by the host application.
Inspection reads existing state and transcripts without starting a model turn.
Private transcript contents are not automatically published to frontend chats.

## Development

Run current behavioral tests locally with controlled providers. No tests contact
a live inference service. Deployment hosts run production builds and brief health
checks, not test suites.
