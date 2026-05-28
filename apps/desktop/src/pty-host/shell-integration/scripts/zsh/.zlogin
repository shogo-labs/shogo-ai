# shogo shell integration — zsh .zlogin (login shells, after .zshrc)
if [ -r "${_SHOGO_ORIG_ZDOTDIR:-$HOME}/.zlogin" ]; then
    . "${_SHOGO_ORIG_ZDOTDIR:-$HOME}/.zlogin"
fi
