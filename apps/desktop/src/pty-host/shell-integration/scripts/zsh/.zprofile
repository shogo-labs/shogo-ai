# shogo shell integration — zsh .zprofile (login shells only)
# Sourced for login shells before .zshrc. Pass through to the user's.

if [ -r "${_SHOGO_ORIG_ZDOTDIR:-$HOME}/.zprofile" ]; then
    . "${_SHOGO_ORIG_ZDOTDIR:-$HOME}/.zprofile"
fi
