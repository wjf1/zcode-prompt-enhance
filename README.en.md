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
│  [📎] [✨]↺⇄      [context] [model ▾] [send]    │  ← ✨ sits in the toolbar, left of the model picker
└─────────────────────────────────────────────────┘
```

- **Click ✨** → the draft is rewritten in place. No dialog, no auto-send.
- **Click ↺** → restore the previous version (8-level undo stack).
- **Click ⇄** → open the diff card, marking every addition and deletion.
- **Click ✨ again while running** → cancel; the draft stays byte-for-byte unchanged.
- **On failure** → the button turns red, hover shows the reason; click again to retry.

### Rewrite strategy

The model fills a six-part skeleton: role and goal, context and constraints, steps, output format,
acceptance criteria, boundary conditions. Three hard rules keep the result usable:

1. **Never fabricate.** Unknown but needed details become `(TBD: …)` placeholders instead of invented facts.
2. **Match the language.** Chinese in → Chinese prompt, English in → English prompt, mixed stays mixed.
3. **Keep the scope.** Do not widen, narrow, or redirect the task.

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

### Choose the enhancement model

Edit `config.json`:

```json
{
  "provider": "new-provider-2",
  "model": "cn:deepseek-v4.1-flash",
  "max_input_chars": 12000,
  "timeout_ms": 60000
}
```

Leaving `provider` and `model` empty picks the first usable route from
`~/.zcode/v2/provider_config.json` by `providerOrder`. Both fields are whitelist-validated; if either is
malformed the whole pair falls back to the default, so a malformed request body can never be built.

Check which model it would pick (this makes a real API call and prints the result):

```bash
node tools/e2e-model.mjs
```

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
| Press Esc while the diff card is open | Close it |

---

## Maintenance

### After a ZCode update

```bash
node repatch_asar.mjs --check    # exit code 1 = injection lost
node repatch_asar.mjs            # re-inject (quit ZCode first)
```

Check whether ZCode has shipped its own enhancement feature (in which case this project is obsolete):

```bash
node -e "const b=require('fs').readFileSync('F:/software/Zcode/resources/app.asar');const s=b.toString('latin1');console.log('enhancePrompt call sites:', s.split('enhancePrompt').length-1)"
```

### Development

Editing `overlay-prompt-enhance.js` or `core/*.mjs` needs **no restart**: the loader polls mtime every 2 s
and re-injects on change (it validates syntax with `new Function` first, so a half-saved file never reaches
the running page).

```bash
npm test                            # 102 unit tests
node tools/preflight.mjs            # static checks (unique ids, security, interface alignment)
node tools/bridge-selftest.mjs      # bridge self-test, including a real model call
node tools/check-asar-loadable.mjs  # confirm the patched asar still loads
node tools/sim-overlay.mjs          # full interaction path in a simulated DOM (incl. rAF-stall regression)
node tools/check-anchor.mjs         # verify ✨ placement against real button rects
node tools/check-multiline.mjs      # multi-line draft round-trip
node tools/verify-writedraft.mjs    # live multi-line write consistency (judged by editor state)
node tools/peek.mjs                 # one-shot live inspection of the overlay + DOM assertions
node tools/e2e-model.mjs            # real model end to end
```

### Uninstall

```bash
node uninstall.mjs    # strips the injection, restores the client (quit ZCode first)
```

Only this project's line is removed; the status bar's injection is untouched.

---

## Design notes

Full analysis and risk table: [`DESIGN.md`](DESIGN.md). Handoff info: [`HANDOFF.md`](HANDOFF.md).

Rules that came out of real failures:

- **Write the draft through Lexical's public API** (`parseEditorState` / `setEditorState`).
  Legacy `execCommand('insertText')` can write but not erase — Lexical's selection is not synchronized
  with the document selection, so programmatic clearing of anything it wrote fails entirely.
- **Verify writes against the editor state, never against `innerText`.**
  Lexical renders each paragraph as a `<p>`, and `innerText` inserts an extra newline between blocks
  (`A\nB` reads as `A\n\nB`). The write itself is correct, but comparing `innerText` would reject
  every multi-line write as a failure.
- **Never drive positioning with `requestAnimationFrame` alone.** Chromium suspends rAF while the window
  is hidden; the loop then stalls, leaving the button at a stale position (on top of a native button)
  and unresponsive. A `setInterval` fallback is required.
- **The API key stays in the main process.** The renderer talks to a loopback bridge (random port +
  random token); credentials are never reachable from the page.
- **A timeout must explicitly close the upstream stream.** Merely stopping the wait leaves the upstream
  generating tokens — and billing for them.
- **The overlay lives on `body` with absolute positioning.** Never inside a React-managed subtree
  (re-renders erase it), and never touching the card's bottom padding (the status bar uses it).

## License

MIT
