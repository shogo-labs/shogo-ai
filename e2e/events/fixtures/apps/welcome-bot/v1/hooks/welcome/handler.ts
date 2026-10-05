import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export default async (event: any) => {
  appendFileSync(join(process.env.WORKSPACE_DIR ?? '.', 'members.log'), `${JSON.stringify(event.context.payload.member)}\n`)
}
