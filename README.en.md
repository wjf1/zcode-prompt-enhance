# zcode-prompt-enhance

Adds a ✨ button next to the chat composer in ZCode Desktop: one click rewrites your draft into a
structured, immediately usable prompt and **fills it back in place**, with multi-level undo.

Inspired by [`wjf1/dsh-prompt-enhance`](https://github.com/wjf1/dsh-prompt-enhance) (a DeepSeek Harness plugin).

English | [简体中文](README.md)

---

## What it does

```
┌─────────────────────────────────────────────────┐
│  Composer (what you typed)                      │
│                                                 │
│  [📎] [✨][std]↺⇄  [context] [model ▾] [send]   │  ← ✨ sits in the toolbar, left of the model picker
└─────────────────────────────────────────────────┘
```

- **Click ✨** → the draft is rewritten in place. No dialog, no auto-send.
- **Click ↺** → restore the previous version (8-level undo stack).
- **Click ⇄** → open the diff card, marking every addition and deletion.
- **Click [std] / [deep]** → switch enhancement depth; the choice is remembered.
- **Click ✨ again while running** → cancel; the draft stays byte-for-byte unchanged.
- **On failure** → the button turns red, hover shows the reason; click again to retry.

### Enhancement depth

| Level | Shape | Good for |
|---|---|---|
| **Standard** (default) | Compact rewrite: one flowing sentence close to your own voice, ≤ 800 chars | Chat inputs, everyday prompts |
| **Deep** | Six-part structured skeleton: role / constraints / steps / output / acceptance / boundaries | Complex tasks, requirements handed to someone else |

Standard matches WorkBuddy's measured behaviour: sharpen the sentence you meant to write instead
of writing a specification on your behalf. The implicit dimensions, deliverable, and judgement
criteria are woven into one sentence ("first … then … and …"); vague references become precise
qualifiers ("其它项目" → "指定的其它同类项目"); no placeholder blocks, no section headers.
Deep is not "longer text": the prompt explicitly asks for more structure and precision, and keeps
the `(TBD: …)` placeholder rule — unknown details are still not invented.

### Scene templates (deep mode only)

Drafts are routed to a **code / data / doc** template by their signals. Only the wording of the
*steps* and *acceptance* sections changes; the six-part skeleton stays intact. When no signal is
found, the generic template is used (identical to no scene enhancement at all).
Standard never gets a scene section — scene instructions would grow structure back into the
single-paragraph shape.
Pin a scene with `scene` in `config.json`, or turn the routing off with `scene_auto: false`.

### Rewrite strategy

Deep fills a six-part skeleton: role and goal, context and constraints, steps, output format,
acceptance criteria, boundary conditions; standard is a single-paragraph compact rewrite.
The hard rules below are shared by both shapes:

1. **Never fabricate.** Unknown but needed details become `(TBD: …)` placeholders instead of invented facts.
2. **Match the language.** Chinese in → Chinese prompt, English in → English prompt, mixed stays mixed.
3. **Keep the scope.** Do not widen, narrow, or redirect the task.

Plus three practical clauses matched against WorkBuddy:

4. **Always improve substantively.** Even a clear draft gets its scope made exact, its deliverable
   named, its acceptance turned checkable — never returned unchanged, never "polished" by wording
   only. Bounded by: the improvement must not import requirements the original never had.
5. **End on a complete statement.** No unfinished list items, dangling conjunctions, or trailing colons.
6. **Expand the request, do not answer it.** Describe WHAT the result must be, not HOW to build it;
   never prescribe technologies the prompt did not name; no unsolicited tutorials.

### Output quality checks

If a result is structurally broken, you are told instead of having it silently written back:

| Situation | Behaviour |
|---|---|
| The model changed nothing of substance | Button turns red: "no substantive change, please retry" |
| Output stops mid-sentence (dangling conjunction / colon / unfinished list item) | "Output incomplete (truncated at the end), please retry" |
| Result is clearly shorter than the original (under 60%) | Written back normally, with a gentle warning |

The first two are blocked outright (your draft is never damaged); the third only warns — shorter
can still be correct.

---

## Why asar injection

The ZCode plugin system **cannot** deliver "a button next to the composer that fills the draft back in:

| Extension point | Limitation |
|---|---|
| Skill + slash command | Result lands in the conversation; you copy-paste it yourself |
| MCP tool | Can't read the current draft; result also lands in the conversation |
| MCP App side panel | Sandbox can't read the main window's draft; `ui/message` *sends* rather than fills back; `availability` is locked to session scope |
| `UserPromptSubmit` hook | Output schema only allows `additionalContext` — there is **no** `updatedPrompt`, so it cannot rewrite input |

So this project injects into the asar: one loader import appended to the client entry, a main-process
service, and an overlay injected into the renderer. This mirrors how the local
`zcode-token-usage-statusbar` works; the two coexist (separate injection markers, neither overwrites the
other, and this project never touches the bottom padding the status bar relies on).

> ⚠️ This modifies the client unofficially. **Every ZCode update wipes the injection** (the client
> replaces `app.asar` wholesale). Re-run `node repatch_asar.mjs` and restart to restore it.

---

## Install

### Requirements

- ZCode Desktop (developed and verified against **3.16.3**)
- Node.js **≥ 22**
- At least one working `anthropic-messages` provider configured in ZCode (this project reuses it directly)

### Steps

```bash
# 1. Clone anywhere
git clone <this-repo> zcode-prompt-enhance
cd zcode-prompt-enhance

# 2. Create config (the defaults pick the first usable provider automatically)
cp config.example.json config.json

# 3. Verify the injection target
node repatch_asar.mjs --dry-run

# 4. Fully quit ZCode (tray menu → Quit), then inject
node repatch_asar.mjs

# 5. Reopen ZCode; the button appears in the composer toolbar
```

Step 4 installs `@electron/asar` automatically (~20 s), then unpacks → backs up → appends → repacks → swaps
(1–3 min). A running ZCode holds the file handle, so **you must quit it first**.

### Which model does it use

**It follows the model currently selected in the conversation by default** — switch the model in the
bottom-right of the composer, and ✨ enhances with that same model.

Detection works by reading the model button's label text in the composer toolbar and matching it against
the real model list in `provider_config.json` ("is a known model id contained in this label"). Model names
are never parsed out by splitting on separators, because ids may themselves contain `/`
(`meta/muse-spark-1.3`, `deepseek/deepseek-v4.1-flash`). Suffixes like "high / medium" for reasoning
effort do not affect the match.

**A failed follow-up falls back automatically** — the feature never breaks:

| Situation | Behaviour |
|---|---|
| Session model exists in `provider_config.json` with an API key | Enhance with that exact model |
| That provider is out of quota / auth fails / unreachable / times out | Retry once with the default model and show "session model unavailable, switched to …" |
| Subscription or OAuth provider (no API key in config) | Fall back to the default model |
| UI change makes the label unreadable, or the match is ambiguous | Fall back to the default model |

After success the overlay reports the model actually used, e.g. "enhanced with session model:
cn:deepseek-v4.1-flash".

To pin a specific model (and stop following), set `provider` and `model` in `config.json`;
leave both empty to follow.

```json
{
  "provider": "",
  "model": "",
  "max_input_chars": 12000,
  "timeout_ms": 60000
}
```

> ⚠️ Note: values in `config.json` are only the **defaults** — a successful follow still wins.
> To pin the enhancer to one model, switch the conversation to that model as well, or accept the
> fallback value.

Inspect what it would follow:

```bash
node tools/check-model-follow.mjs     # validate the matching algorithm against real aria samples
node tools/check-follow-live.mjs      # resolve and really call each route
```

### Conversation context (optional, off by default)

With `context_enabled` in `config.json`, an enhance request may carry a budgeted slice of
conversation context (`<conversation_context>`) so the rewrite can resolve pronouns and prior
agreements:

```json
{
  "context_enabled": false,
  "context_max_messages": 8,
  "context_max_chars": 4000
}
```

- Assembly lives in `core/context.mjs`: newest-first retention (turns closest to the draft win),
  dual budget on message count and characters, delimiter-escaped before entering the user message.
- **Off by default = byte-identical to the no-context baseline** (the system prompt gains no context
  section; guarded by tests).
- The renderer does not report context yet (reading the chat log depends on host DOM structure with
  no stable selectors); the main-process assembly pipeline is ready and takes effect once a
  collector is wired up.

---

## Daily use

| Action | Result |
|---|---|
| Look at ✨ with an empty draft | Greyed out; hover says "type something first" |
| Click ✨ | Spinner; click again to cancel |
| Success | Draft replaced in place, diff card opens, ↺ and ⇄ appear |
| Click ↺ | Restore the previous version; repeat up to 8 levels |
| Edit the draft yourself | The whole undo stack is invalidated |
| Edit the draft during a request | Result is discarded, with a notice |
| Press Esc while the diff card is open | Close it (only when focus is inside the card; the host's own Esc handling is untouched) |
| Button position stays wrong | After 5 s a one-time notice: "button position may be inaccurate (UI layout changed)" |
| Editing the draft clears the undo stack | Notice: "undo history cleared" |

---

## Maintenance

### Security model (since 0.3.0)

The bridge token is a random constant with the lifetime of the process and **never expires**, so the
surface that can see it must be narrowed:

- Tokens are injected only into **trusted windows**: by default only local packaging protocols
  (`file:` / `app:` / `chrome-extension:` / `devtools:`). Remote pages get nothing unless their host is
  explicitly listed in `config.json`:
  ```json
  { "allowed_window_hosts": ["zcode.z.ai"] }
  ```
  The main window currently loads via `loadFile(.../renderer/index.html)`, i.e. `file:`, so the default
  configuration works as-is.
- The bridge checks the `Host` header **before** the token: it must be `127.0.0.1:<port>` or
  `localhost:<port>`. This blocks DNS rebinding — an attacker domain can resolve to 127.0.0.1 (so the
  source IP is local too), but the `Host` header still carries their domain.

### Diagnostics

```bash
curl -s -H "x-zpe-token: <token>" http://127.0.0.1:<port>/health
```

`/health` reports `configPath` and `configShape` (`anthropic-v2` / `unknown` / `missing`), which
separates "no config at all / config directory moved / config format changed" instead of collapsing all
three into one `unsupported`.

In the page, `window.__zpeState()` also exposes `anchorDegraded` and `anchorVia`. Any `anchorVia` other
than `cluster` means the toolbar no longer looks the way we expect and positioning is running degraded.

### After a ZCode update

```bash
node repatch_asar.mjs --check    # exit code 1 = injection lost
node repatch_asar.mjs            # re-inject (quit ZCode first)
```

Check whether ZCode has shipped its own enhancement feature (in which case this project is obsolete):

```bash
node -e "const b=require('fs').readFileSync('E:/ZCode/resources/app.asar');const s=b.toString('latin1');console.log('enhancePrompt call sites:', s.split('enhancePrompt').length-1)"
```

Since 0.3.3 there is a lightweight **update detector**: while the injection is alive, the loader compares
`app.getVersion()` against the last recorded version (`.zpe-host-state.json`) at host startup and logs a
hint to re-run `--check` when the version changed. When the asar was replaced wholesale the loader itself
does not run, so the hint is unreachable in that case — run the command above directly once the button
disappears.

### /enhance fallback command (while ✨ is broken)

While the button or the injection is gone, a CLI path sends the draft to the same enhancement core
(reusing provider routing / timeout / error codes; uses the `config.json` default route instead of
following the session model). The result lands in the conversation for manual copy-paste:

```bash
node tools/enhance-cli.mjs "draft text"         # as an argument
node tools/enhance-cli.mjs --file draft.txt     # from a file
echo draft | node tools/enhance-cli.mjs         # from stdin
```

Install as a ZCode command / skill (either is enough):

- Command: copy `commands/enhance.md` to `~/.zcode/commands/enhance.md` (or the project-level
  `.zcode/commands/enhance.md`), then use `/enhance <draft>`;
- Skill: `npx skills add wjf1/zcode-prompt-enhance -s enhance -a zcode -g -y`.

### Development

Editing `overlay-prompt-enhance.js` or `core/*.mjs` needs **no restart**: the loader polls mtime every 2 s
and re-injects on change (it validates syntax with `new Function` first, so a half-saved file never reaches
the running page).

```bash
npm test                            # 171 unit tests
node tools/preflight.mjs            # static checks (unique ids, security, interface alignment)
node tools/bridge-selftest.mjs      # bridge self-test incl. Host check and a real model call
node tools/inject-gate-selftest.mjs # injection-gate lifecycle self-test (stubbed electron)
node tools/check-core-url.mjs       # core modules import correctly through file:// URLs
node tools/check-asar-loadable.mjs  # confirm the patched asar still loads
node tools/sim-overlay.mjs          # full interaction path in a simulated DOM (rAF stall, position cache, a11y)
node tools/check-multiline.mjs      # multi-line draft round-trip
node tools/verify-writedraft.mjs    # live multi-line write consistency (judged by editor state)
node tools/peek.mjs                 # one-shot live inspection of the overlay + DOM assertions
node tools/e2e-model.mjs            # real model end to end
```

> ⚠️ The single source of truth for the diff algorithm is `core/diff.mjs`: the block embedded in the
> overlay is generated at build time by `npm run build:overlay` — **never hand-edit** the code inside the
> `[ZPE:DIFF:BEGIN]` marker region of the overlay. After changing `core/diff.mjs`, run that script to sync;
> `--check` validates that the artifact is current (`test/overlay-diff.test.mjs` stays as a behavioral
> artifact check).

### Uninstall

```bash
node uninstall.mjs    # strips the injection, restores the client (quit ZCode first)
```

Only this project's line is removed; the status bar's injection is untouched.

---

### Known limitations

- Every ZCode update replaces `app.asar` wholesale, wiping the injection (the button silently
  disappears). Re-run `node repatch_asar.mjs` and restart.
- Following the session model depends on reading the toolbar button's label. A UI restructure can make
  that unreadable; the enhancer then falls back to the default model (still functional, just no longer
  following).
- `allowed_window_hosts` defaults to empty. If a future release switches the main window to remote
  loading, the button disappears; list the actual host to fix it. Do **not** default to allowing all
  `http`/`https`.
- When the toolbar is completely full, ✨ hides rather than overlapping the send button. That is a
  deliberate trade-off, not a bug.
- **No streaming preview** (the draft area never shows partial output while enhancing) — deliberate:
  previewing would require periodically replacing the whole editor state, racing the user's typing and
  defeating the "draft changed during request → discard result" guard. Progress is visible on the
  button tooltip; the full result lands in one step with the diff card.

## Design notes

Full analysis and risk table: [`DESIGN.md`](DESIGN.md). Handoff info: [`HANDOFF.md`](HANDOFF.md).

Rules that came out of real failures:

- **Write the draft through Lexical's public API** (`parseEditorState` / `setEditorState`).
  Legacy `execCommand('insertText')` can write but not erase — Lexical's selection is not synchronized
  with the document selection, so programmatic clearing of anything it wrote fails entirely.
- **Verify writes against the editor state, never against `innerText`.**
  Lexical renders each paragraph as a `<p>`, and `innerText` inserts an extra newline between blocks
  (`A\nB` reads as `A\n\nB`). The write itself is correct, but comparing `innerText` would reject
  every multi-line write as a failure. Since 0.3.0 `innerText` is used only to short-circuit the polling
  loop when nothing changed — never as a comparison basis.
- **Never drive positioning with `requestAnimationFrame` alone.** Chromium suspends rAF while the window
  is hidden; the loop then stalls, leaving the button at a stale position (on top of a native button)
  and unresponsive. A `setInterval` fallback is required.
- **Hide rather than cover native UI.** If no gap avoids every native button rect, positioning returns
  `hidden`. The "bottom-right corner" fallback overlapped the send button outright under the real
  3.16.3 rects — a safety net is only safe once it has been verified.
- **The API key stays in the main process.** The renderer talks to a loopback bridge (random port +
  random token + Host check); credentials are never reachable from the page.
- **A timeout must explicitly close the upstream stream.** Merely stopping the wait leaves the upstream
  generating tokens — and billing for them. Timeout fallback only runs when not a single token was
  received (`hadFirstChunk === false`); otherwise one click bills twice.
- **The overlay lives on `body` with absolute positioning.** Never inside a React-managed subtree
  (re-renders erase it), and never touching the card's bottom padding (the status bar uses it).

## License

MIT
