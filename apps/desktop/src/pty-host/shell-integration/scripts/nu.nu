# shogo shell integration — Nushell
#
# Sourced from a generated config snippet. The wrapper loader is
# responsible for executing the user's `config.nu` and `env.nu` BEFORE
# this file so user customisations win wherever they conflict with us.
#
# What this script does:
#
#   1. Defines an `__shogo_osc633` helper that emits the VS Code
#      shell-integration sequences (OSC 633 ; A/B/C/D/P) as raw bytes.
#      These are the same marks the bash / zsh / fish / pwsh scripts in
#      this directory emit; the surface UI in apps/mobile/.../Terminal.tsx
#      parses them via `parser.parseOscSequence` into prompt/command/cwd
#      events.
#
#   2. Installs three hooks on `$env.config.hooks`:
#        - pre_prompt          → emit "A" (prompt start)
#        - pre_execution       → emit "C" (command start)
#        - env_change.PWD      → emit "P;Cwd=<path>" (cwd changed)
#
#   3. Wraps the user's prompt via PROMPT_COMMAND so the "B" (prompt end)
#      sequence is flushed right before the cursor lands on the input
#      line. We can't add a post_prompt hook in Nushell so this is the
#      least invasive substitute.
#
# Safety notes:
#
#   * `$env.config.hooks.*` is an array in modern Nushell (>= 0.80). We
#     APPEND to whatever the user already has so we never clobber theirs.
#     On older Nushell the type might be a record; we guard with a `try`
#     so an incompatible config silently degrades to a no-op rather than
#     crashing the shell on startup.
#
#   * The `__shogo_*` names start with double underscore by convention
#     to mark them as private and avoid colliding with user functions.
#
#   * If `$env.SHOGO_DISABLE_SHELL_INTEGRATION` is set to `1`, we exit
#     this script early without installing any hooks. Same env-var the
#     bash / zsh / pwsh scripts honour.

if ($env.SHOGO_DISABLE_SHELL_INTEGRATION? == "1") {
    # User opted out — leave hooks untouched.
} else {
    # ── OSC 633 helpers ──────────────────────────────────────────────
    #
    # `ESC ] 633 ; X ST` is the framing. We build the bytes by hand using
    # `char esc` because Nushell's escape sequences in string literals
    # are inconsistent across versions.

    def --env __shogo_osc633 [code: string, data?: string] {
        let esc = (char esc)
        let payload = if ($data | is-empty) { $"($esc)]633;($code)($esc)\\" } else { $"($esc)]633;($code);($data)($esc)\\" }
        print -n $payload
    }

    def --env __shogo_emit_prompt_start [] { __shogo_osc633 "A" }
    def --env __shogo_emit_prompt_end   [] { __shogo_osc633 "B" }
    def --env __shogo_emit_command_start [] { __shogo_osc633 "C" }
    def --env __shogo_emit_command_done [exit: int = 0] { __shogo_osc633 "D" $"($exit)" }
    def --env __shogo_emit_cwd [path: string] { __shogo_osc633 "P" $"Cwd=($path)" }

    # ── Hook installation (best-effort) ─────────────────────────────
    #
    # Modern Nushell stores hooks under $env.config.hooks. Each named
    # hook is a LIST of closures or strings, in insertion order. We
    # append ours so the user's hooks still run.

    try {
        let pre_prompt_existing = ($env.config.hooks.pre_prompt? | default [])
        let pre_exec_existing = ($env.config.hooks.pre_execution? | default [])
        let env_change_existing = ($env.config.hooks.env_change? | default {})
        let pwd_existing = ($env_change_existing.PWD? | default [])

        $env.config = ($env.config | upsert hooks {|c|
            ($c.hooks
                | upsert pre_prompt ($pre_prompt_existing | append { || __shogo_emit_prompt_start; __shogo_emit_cwd ($env.PWD); __shogo_emit_prompt_end })
                | upsert pre_execution ($pre_exec_existing | append { || __shogo_emit_command_start })
                | upsert env_change ($env_change_existing | upsert PWD ($pwd_existing | append { |_before, after| __shogo_emit_cwd ($after) }))
            )
        })

        # Emit an initial cwd marker so the panel has the starting
        # directory before the first prompt fires.
        __shogo_emit_cwd ($env.PWD)
    } catch {
        # Older or customised Nushell — leave the user's shell alone.
    }
}
