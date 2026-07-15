/**
 * pi-for — a pi extension that adds a `$for@` prompt-loop editor feature.
 *
 * ---------------------------------------------------------------------------
 * What it does
 * ---------------------------------------------------------------------------
 * While composing a message you can write `$for@` (dollar + "for" + at-sign).
 * Because vanilla pi only opens its fuzzy file/directory search when `@` follows
 * a space, this extension additionally opens that same search when `@` follows
 * `$for`. Pick a path and the in-editor command becomes `$for@<file-or-dir>`.
 *
 * When such a message is submitted, the extension runs a *prompt loop*:
 *
 *   - If the path points to a DIRECTORY, the loop iterates over every child
 *     element (files and subdirectories). Each iteration replaces
 *     `$for@<dir>` with `$for@<dir>/<child>`.
 *   - If the path points to a FILE, the loop iterates over every line of the
 *     file. Each iteration replaces `$for@<file>` with `$for@<line>`.
 *
 * Iterations are strictly sequential (no parallelism). The first iteration is
 * sent as a normal message. Every following iteration FORKS the session from the
 * previous iteration's user message (position "before") so that the previous
 * message is replaced while the earlier conversation context is preserved, then
 * sends the next replacement. While the loop runs, a hint is shown in the same
 * region the UI normally uses for queued messages.
 *
 * ---------------------------------------------------------------------------
 * Implementation notes
 * ---------------------------------------------------------------------------
 * - The `$for@` fuzzy search reuses pi's built-in autocomplete by wrapping the
 *   active AutocompleteProvider (via `ctx.ui.addAutocompleteProvider`) and by
 *   extending the editor (`CustomEditor`) so that typing `$for@` opens it.
 * - The loop itself runs from a command (`/for-loop`) because forking the
 *   session is only available on the command context, not on the `input` event
 *   context. The `input` handler detects `$for@<path>`, stashes the message and
 *   dispatches `/for-loop`.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  EditorComponent,
  EditorTheme,
  KeybindingsManager,
  TUI,
} from "@earendil-works/pi-tui";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

// `$for@` followed by a (possibly empty) token of non-space, non-@ characters.
// Used to detect the trigger while typing / at the cursor.
const FOR_CONTEXT_RE = /\$for@([^@\s]*)$/;
// Global variant used to find the token anywhere in a submitted message.
const FOR_TOKEN_RE = /\$for@(\S+)/;
// Bare trigger with no path (e.g. `$for@ ` or a message ending in `$for@`).
const FOR_BARE_RE = /\$for@(?=\s|$)/;

const FOR_WIDGET_KEY = "pi-for";

interface ForLoopPlan {
  /** The original message text that contains the `$for@<path>` token. */
  text: string;
}

interface ForState {
  cwd: string;
  /** Stashed plan waiting for the `/for-loop` command to pick it up. */
  loop: ForLoopPlan | null;
}

const state: ForState = {
  cwd: process.cwd(),
  loop: null,
};

let providerRegistered = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the `$for@` replacement value for a directory child. */
function childReplacement(tokenPath: string, childName: string): string {
  if (tokenPath === "" || tokenPath === ".") return childName;
  if (tokenPath.endsWith("/")) return tokenPath + childName;
  return tokenPath + "/" + childName;
}

/** Truncate a string for compact hint rendering. */
function truncate(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** Find the id of the most recent user message entry in the session. */
function lastUserEntryId(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type: string; message?: { role?: string } };
    if (e.type === "message" && e.message?.role === "user") return e.id;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Autocomplete provider: makes `$for@` open the fuzzy file/directory search.
// ---------------------------------------------------------------------------

class ForAutocompleteProvider implements AutocompleteProvider {
  // Keep `@` (and `#`) as trigger characters; the editor seeds these by default
  // anyway, this just keeps the combined provider honest.
  triggerCharacters = ["@", "#"];
  private readonly current: AutocompleteProvider;
  private readonly getCwd: () => string;

  constructor(current: AutocompleteProvider, getCwd: () => string) {
    this.current = current;
    this.getCwd = getCwd;
  }

  shouldTriggerFileCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean {
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
    if (FOR_CONTEXT_RE.test(before)) return true;
    return this.current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    opts: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
    const m = before.match(FOR_CONTEXT_RE);
    if (!m) {
      return this.current.getSuggestions(lines, cursorLine, cursorCol, opts);
    }
    const partial = m[1];
    const items = this.buildItems(partial);
    return items.length ? { items, prefix: partial } : null;
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
    const m = before.match(FOR_CONTEXT_RE);
    if (m) {
      const token = m[0]; // "$for@<partial>"
      const start = before.length - token.length;
      const after = (lines[cursorLine] ?? "").slice(cursorCol);
      const newBefore = before.slice(0, start) + "$for@" + item.value;
      const newLines = lines.slice();
      newLines[cursorLine] = newBefore + after;
      return { lines: newLines, cursorLine, cursorCol: newBefore.length };
    }
    return this.current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  private buildItems(partial: string): AutocompleteItem[] {
    const cwd = this.getCwd();

    let dirPart: string;
    let baseName: string;
    if (partial === "") {
      dirPart = "";
      baseName = "";
    } else if (partial.endsWith("/")) {
      dirPart = partial;
      baseName = "";
    } else {
      const lastSlash = partial.lastIndexOf("/");
      if (lastSlash === -1) {
        dirPart = "";
        baseName = partial;
      } else {
        dirPart = partial.slice(0, lastSlash + 1);
        baseName = partial.slice(lastSlash + 1);
      }
    }

    const targetDir = resolve(cwd, dirPart || ".");
    let entries: ReturnType<typeof readdirSync> | undefined;
    try {
      entries = readdirSync(targetDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const base = baseName.toLowerCase();
    const items: AutocompleteItem[] = [];
    for (const e of entries) {
      if (e.name === "." || e.name === "..") continue;
      const isDir = e.isDirectory();
      // Lightweight "fuzzy": substring match on the partial basename.
      if (base && !e.name.toLowerCase().includes(base)) continue;
      const value = dirPart === "" ? e.name : dirPart + e.name;
      items.push({
        value,
        label: isDir ? e.name + "/" : e.name,
        description: isDir ? "directory" : "file",
      });
    }

    // Directories first, then alphabetical.
    items.sort((a, b) => {
      const ad = a.description === "directory" ? 0 : 1;
      const bd = b.description === "directory" ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.label.localeCompare(b.label);
    });

    return items;
  }
}

// ---------------------------------------------------------------------------
// Editor: extends the default editor so that typing `$for@` opens the search.
// ---------------------------------------------------------------------------

class ForEditor extends CustomEditor {
  handleInput(data: string): void {
    // Let the default editor handle everything (typing, native `@` after space,
    // autocomplete continuation, etc.).
    super.handleInput(data);

    try {
      const { line, col } = this.getCursor();
      const lines = this.getLines();
      const before = (lines[line] ?? "").slice(0, col);
      if (FOR_CONTEXT_RE.test(before) && !this.isShowingAutocomplete()) {
        // The built-in trigger only fires when `@` follows a space/tab, so we
        // explicitly open the autocomplete for the `$for@` context. This method
        // is private on Editor but present on the prototype at runtime.
        const trigger = (
          this as unknown as { tryTriggerAutocomplete?: () => void }
        ).tryTriggerAutocomplete;
        if (typeof trigger === "function") trigger.call(this);
      }
    } catch {
      // Never let autocomplete wiring break normal editing.
    }
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    state.cwd = ctx.cwd;

    // Register the autocomplete provider exactly once per extension runtime.
    if (!providerRegistered) {
      ctx.ui.addAutocompleteProvider(
        (current) => new ForAutocompleteProvider(current, () => state.cwd),
      );
      providerRegistered = true;
    }

    // Wrap the editor so `$for@` opens the fuzzy file/directory search.
    ctx.ui.setEditorComponent(
      (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager): EditorComponent =>
        new ForEditor(tui, theme, keybindings),
    );
  });

  pi.on("session_shutdown", () => {
    // Drop any stale plan if the session ends mid-loop.
    state.loop = null;
  });

  // Detect a submitted message that contains `$for@<path>` and hand it to the
  // loop command. We only act on user-typed / RPC input, never on messages we
  // inject ourselves (source === "extension").
  pi.on("input", (event, ctx): InputEventResult | void => {
    if (event.source === "extension") return { action: "continue" };

    const text = event.text;
    if (!FOR_TOKEN_RE.test(text)) return { action: "continue" };

    if (FOR_BARE_RE.test(text)) {
      ctx.ui.notify("pi-for: $for@ needs a file or directory path", "warning");
      return { action: "handled" };
    }

    // Stash the plan, then dispatch the internal loop command. Returning
    // "handled" drops the original (still containing `$for@<path>`) message; the
    // queued `/for-loop` user message is processed through the normal pipeline
    // (command check first), so the loop command picks up the stashed plan and
    // runs the sequential fork-based loop. This mirrors the send-user-message
    // pattern: `pi.sendUserMessage` always triggers a turn.
    state.loop = { text };
    pi.sendUserMessage("/for-loop");
    return { action: "handled" };
  });

  // The loop command: runs the sequential fork-based prompt loop.
  pi.registerCommand("for-loop", {
    description:
      "Run a $for@ prompt loop (internal — triggered by $for@ in a message).",
    handler: async (_args, ctx) => {
      const plan = state.loop;
      state.loop = null;
      if (!plan) return;

      const m = plan.text.match(FOR_TOKEN_RE);
      if (!m) return;
      const tokenPath = m[1];
      const cwd = ctx.cwd;
      const absPath = resolve(cwd, tokenPath);

      let kind: "directory" | "line";
      let replacements: string[];
      try {
        if (!existsSync(absPath)) throw new Error("path does not exist");
        const st = statSync(absPath);
        if (st.isDirectory()) {
          kind = "directory";
          const children = readdirSync(absPath, { withFileTypes: true });
          replacements = children
            .filter((e) => e.name !== "." && e.name !== "..")
            .map((e) => childReplacement(tokenPath, e.name));
        } else if (st.isFile()) {
          kind = "line";
          const content = readFileSync(absPath, "utf8");
          const lines = content.split("\n");
          if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
          replacements = lines;
        } else {
          throw new Error("not a file or directory");
        }
      } catch (err) {
        ctx.ui.notify(
          `pi-for: cannot loop over ${tokenPath}: ${(err as Error).message}`,
          "error",
        );
        return;
      }

      if (replacements.length === 0) {
        ctx.ui.notify(`pi-for: no iterations found for ${tokenPath}`, "warning");
        return;
      }

      const total = replacements.length;
      const kindLabel = kind === "directory" ? "directory" : "line";

      const showHint = (c: ExtensionContext, i: number) => {
        const idx = i + 1;
        const cur = replacements[i];
        c.ui.setWidget(FOR_WIDGET_KEY, [
          `for-loop · iteration ${idx}/${total} · ${kindLabel}`,
          `↳ ${truncate(cur)}`,
        ]);
      };
      const clearHint = (c: ExtensionContext) => {
        try {
          c.ui.setWidget(FOR_WIDGET_KEY, undefined);
        } catch {
          /* ignore */
        }
      };

      const replaceToken = (replacement: string) =>
        plan.text.replace(FOR_TOKEN_RE, `$for@${replacement}`);

      try {
        // Iteration 0 — sent normally, no fork.
        showHint(ctx, 0);
        await pi.sendUserMessage(replaceToken(replacements[0]));
        await ctx.waitForIdle();

        // Iterations 1..N-1 — fork to replace the previous message, keeping the
        // earlier conversation context. Forking from within each `withSession`
        // callback chains the loop across sessions safely.
        const runNext = async (
          sctx: ExtensionContext & {
            fork: (
              entryId: string,
              options?: {
                position?: "before" | "at";
                withSession?: (ctx: ExtensionContext) => Promise<void>;
              },
            ) => Promise<{ cancelled: boolean }>;
          },
          entryId: string,
          i: number,
        ): Promise<void> => {
          if (i >= total) return;
          showHint(sctx, i);
          await sctx.fork(entryId, {
            position: "before",
            withSession: async (nctx) => {
              await nctx.sendUserMessage(replaceToken(replacements[i]));
              await nctx.waitForIdle();
              const newEntryId = lastUserEntryId(nctx);
              if (newEntryId) {
                await runNext(
                  nctx as Parameters<typeof runNext>[0],
                  newEntryId,
                  i + 1,
                );
              }
              // Last iteration finished: clear the hint on the live (forked)
              // session so it disappears as soon as the loop ends.
              if (i + 1 >= total) clearHint(nctx);
            },
          });
        };

        const firstEntryId = lastUserEntryId(ctx);
        if (firstEntryId) {
          await runNext(ctx as Parameters<typeof runNext>[0], firstEntryId, 1);
        }
      } finally {
        clearHint(ctx);
      }
    },
  });
}
