# pi-for

A [pi](https://github.com/earendil-works/pi) extension that adds a `$for@`
prompt-loop editor feature with variable insertion.

## What it does

While composing a message, write `$for@` (dollar + `for` + at-sign). Vanilla pi
only opens its fuzzy file/directory search when `@` follows a space; this
extension additionally opens that same search when `@` follows `$for`. Pick a
path and the in-editor command becomes `$for@<file-or-dir>`.

When such a message is submitted, the extension runs a **prompt loop**:

- **Directory** — if the path points to a directory, the loop iterates over all
  of its child elements (files and subdirectories). Each iteration replaces
  `$for@<dir>` with the bare path `<dir>/<child>` (the `$for@` marker is dropped,
  so the iterated prompts contain only the resolved path).
- **File (lines)** — if the path points to a file, the loop iterates over every
  line of the file. Each iteration replaces `$for@<file>` with the bare value
  `<line>` (the `$for@` marker is dropped).

Iterations run strictly sequentially (no parallelism). The first iteration is
sent as a normal message. Every following iteration **forks** the session from
the previous iteration's user message (position `before`) so the previous
message is replaced while the earlier conversation context is preserved, then
sends the next replacement.

While the loop runs, a hint is shown in the same region the UI normally uses for
queued messages, e.g.:

```
for-loop · iteration 2/5 · directory
↳ ./skills/baking
```

## Example

Given two subdirectories `karate` and `baking` inside `./skills/`:

```
User:  Have a look at the readme
Pi:    (acknowledges)
User:  Please reword the skill in $for@./skills/ and make it more polite
```

This expands to:

```
User:  Please reword the skill in ./skills/karate and make it more polite
       ... (wait for answer) ...
       fork → replace last message
User:  Please reword the skill in ./skills/baking and make it more polite
```

## Install

```bash
pi install git:github.com/jejay/pi-for
```

Or try it without installing:

```bash
pi -e ./index.ts
```

## How it works

- The `$for@` fuzzy search reuses pi's built-in autocomplete: the extension
  wraps the active `AutocompleteProvider` (via `ctx.ui.addAutocompleteProvider`)
  and extends the editor (`CustomEditor`) so that typing `$for@` opens the
  search.
- The loop runs from an internal `/for-loop` command, because forking the
  session is only available on the command context, not on the `input` event
  context. The `input` handler detects `$for@<path>`, stashes the message, and
  dispatches `/for-loop`.

## License

MIT
