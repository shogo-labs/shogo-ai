# shogo shell integration — fish
#
# Dropped into $XDG_CONFIG_HOME/fish/conf.d/shogo-integration.fish.
# fish auto-sources every .fish file in conf.d for both interactive
# and login shells. We layer on top of the user's config rather than
# replacing it.

if test "$SHOGO_DISABLE_SHELL_INTEGRATION" = "1"
    exit 0
end
if set -q __shogo_integration_loaded
    exit 0
end
set -g __shogo_integration_loaded 1

function __shogo_osc -a payload
    printf '\033]633;%s\007' $payload
end

function __shogo_preexec_hook --on-event fish_preexec
    __shogo_osc 'C'
end

function __shogo_postexec_hook --on-event fish_postexec
    set -l exit $status
    __shogo_osc "D;$exit"
    __shogo_osc "P;Cwd=$PWD"
    __shogo_osc 'A'
end

# Wrap the user's fish_prompt to emit B (prompt-end) just before each
# prompt renders. We rename the original so it can still produce the
# user's customised prompt characters.
if functions -q fish_prompt
    functions --copy fish_prompt __shogo_user_fish_prompt
    function fish_prompt
        __shogo_user_fish_prompt
        __shogo_osc 'B'
    end
else
    function fish_prompt
        printf '> '
        __shogo_osc 'B'
    end
end

# Initial Cwd + A so the tracker has an anchor for the very first prompt.
__shogo_osc "P;Cwd=$PWD"
__shogo_osc 'A'
