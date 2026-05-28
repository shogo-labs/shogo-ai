# shogo shell integration — zsh .zlogout (login shells, on exit)
if [ -r "${_SHOGO_ORIG_ZDOTDIR:-$HOME}/.zlogout" ]; then
    . "${_SHOGO_ORIG_ZDOTDIR:-$HOME}/.zlogout"
fi
