#!/usr/bin/env node

const target = 'apps/shogo-ide/upstream/vscode'

console.log(`git clone --depth 1 https://github.com/microsoft/vscode.git ${target}`)
console.log('')
console.log('After cloning, run Code - OSS build commands from the upstream checkout, not from the Shogo monorepo root.')
console.log('Keep the checkout ignored until we decide whether to use a separate fork, submodule, subtree, or scripted checkout.')
