---
name: scheduled-tasks
description: Create, edit, or remove Clara scheduled tasks. Tasks are JS or TS files in the current user's tasks/ directory and can run code or a native Pi inference session.
---

# Scheduled tasks

Task files belong in `tasks/` under the user's profile working directory.
Use a descriptive `.js` or `.ts` filename. Start the file with this header:

```js
/**
 * @every 5 minutes
 * @mode deterministic
 */
export default async function ({ cwd, user, signal }) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile('tasks/example.txt', `Hello from ${user}\n`);
}
```

`@every` is the interval between scheduled starts. It accepts seconds, minutes,
hours, days, weeks, calendar months, and years, including shorthand such as
`5m`, `13h`, and `6 months`. A newly discovered file first becomes due after its
interval. Editing the interval recalculates it from the last start; editing the
body alone keeps its schedule.

`@mode deterministic` runs the exported function once, with the user's profile
as its current directory. The arguments are the absolute `cwd`, the username
`user`, and an `AbortSignal`. Await all work before returning; a task is not a
place to start a detached service or leave timers running.

The header is ordinary JavaScript comment text. TypeScript uses Node's native
type stripping; use erasable types and explicit file extensions for local imports.
The scheduler reads headers without executing the files. Imports and the task
body execute only when the task is picked up.

## Inference

```js
/**
 * @every 13h
 * @mode inference
 * @session continue
 */
export default `Continue the work described in this task's notebook.
Use the existing notebook and scratchpad tools when useful.`;
```

An inference task exports either a prompt string or an async function returning
a prompt string. That function receives the same arguments as a deterministic
task, so it can gather deterministic input before forming the prompt.

`@session fresh` starts a new conversation each run and is the default.
`@session continue` reopens this task's previous conversation. Each task has its
own conversation; it does not reuse a frontend chat. Native Pi loads the owner's
settings, SOUL, model, and permitted tools. The prompt is passed as a task custom
message; the scheduler does not add an agenda or require a particular result.

### Task-specific settings

An inference task can also export a `settings` object with ordinary Pi settings:

```js
/**
 * @every 1 day
 * @mode inference
 * @session fresh
 */
export const settings = {
  modularSoul: {
    defaultSoul: 'task',
    souls: { task: './TASK_SOUL.md' },
  },
  songya: [
    { user: 'agent', store: './agent-memory', recallEnabled: false },
  ],
};
export default 'Process the material described in your task SOUL.';
```

The host merges these overrides into the owner's settings using Pi's normal
rules before loading extensions. Relative paths still use the owner's profile
directory. The selected SOUL file must exist; this example does not create one.
Overrides and settings changes made by that session stay in memory, including
across a resource reload. The user's settings files are not rewritten.
Household model and permission controls still apply.

Omitting `settings` keeps the usual profile configuration. Settings are read
again on the next run. A continued conversation retains its existing SOUL
selection; use `@session fresh` to start with a different default selection.

For example, a less frequent task can use:

```js
/**
 * @every 6 months
 * @mode inference
 * @session fresh
 */
export default 'Read the notebook named in this task and reconsider its open questions.';
```

These are examples of file structure, not tasks to install automatically.

## Queue and frontend priority

All users share one queue. The oldest due task runs first. No second task starts
until that task finishes, including while it is waiting for a frontend chat.
Overdue intervals do not create a backlog of duplicate occurrences.

Frontend chats always take priority. Tasks wait while any frontend chat is
running. If a message arrives during inference or a tool call, that call finishes,
then the task waits before its next call. It resumes when frontend chats are idle.
A deterministic function is one call, so keep it reasonably bounded.

## Changes and stored progress

- Add a task by creating its file. It is discovered on the next scheduler tick.
- Modify its header or body by editing that file.
- Remove it by deleting the file. An occurrence already running is allowed to finish.
- Moving or renaming a file gives it a new task identity and schedule.

Scheduling progress lives in `.pi/runtime/tasks.json` inside the profile.
Inference conversations live in `tasks/.sessions/<task-filename>/`. Do not edit
the progress file to implement task logic; use ordinary files or notebooks for
the task's own working data.

Started occurrences are not automatically replayed after a service crash.
Their next scheduled occurrence remains recorded. Continued conversations survive
restarts. A failed task reports its error and leaves the queue available for the
next task. Fix its file; it will be attempted at its next scheduled time.

Tasks are executable automation code. Do not put secrets or personal tasks in
the package repository. Store them only in the owning user's profile.
