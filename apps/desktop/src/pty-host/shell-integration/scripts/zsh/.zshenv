# shogo shell integration — zsh .zshenv
#
# This file sits in the temporary ZDOTDIR. zsh sources .zshenv on EVERY
# invocation (interactive, non-interactive, login, sub-shells). Our job
# here is exactly two things:
#
#   1. Restore the user's original ZDOTDIR so their dotfiles still source.
#   2. Source the user's own .zshenv from that location, if it exists.
#
# We deliberately do NOT install any hooks here — those go in .zshrc
# (interactive only) so non-interactive sub-shells stay clean.

if [ -n "${_SHOGO_ORIG_ZDOTDIR-}" ]; then
    ZDOTDIR="$_SHOGO_ORIG_ZDOTDIR"
else
    # The user had no ZDOTDIR — fall back to $HOME (zsh's default).
    ZDOTDIR="$HOME"
fi
export ZDOTDIR

if [ -r "$ZDOTDIR/.zshenv" ]; then
    . "$ZDOTDIR/.zshenv"
fi
