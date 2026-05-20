export function build(file?: string, line?: number) {
  let cmd = 'x'
  if (file) {
    if (line != null && line > 0) {
      cmd += ` "${file}:${line}"`
    } else {
      cmd += ` "${file}"`
    }
  }
  return cmd
}
