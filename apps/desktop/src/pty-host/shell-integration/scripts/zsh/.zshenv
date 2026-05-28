# shogo shell integration — zsh .zshenv
#
# zsh sources .zshenv on EVERY invocation (interactive, non-interactive,
# login, sub-shells). Our job here is exactly one thing: source the user's
# own .zshenv from their ORIGINAL ZDOTDIR if it exists.
#
# CRITICAL: we must NOT mutate ZDOTDIR. If we did, zsh's next step
# ("source $ZDOTDIR/.zshrc") would read the user's .zshrc and entirely
# skip ours — no hooks would be installed and the terminal would show
# no OSC 633 marks. ZDOTDIR stays pointed at our temp dir for the
# duration of zsh startup; our .zshrc takes care of sourcing the user's
# .zshrc explicitly.
#
# We deliberately do NOT install any hooks here — those go in .zshrc
# (interactive only) so non-interactive sub-shells stay clean.

_SHOGO_USER_ZDOTDIR="${_SHOGO_ORIG_ZDOTDIR:-$HOME}"

if [ -r "$_SHOGO_USER_ZDOTDIR/.zshenv" ]; then
    . "$_SHOGO_USER_ZDOTDIR/.zshenv"
fi
