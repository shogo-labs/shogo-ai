export default async (event: any) => {
  const { payload } = event.context
  const token = event.context.appToken ?? process.env.SHOGO_APP_TOKEN
  const apiUrl = event.context.apiUrl ?? process.env.SHOGO_API_URL
  const call = async (method: string, body: Record<string, unknown>) => {
    const res = await fetch(`${apiUrl}/api/v1/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json: any = await res.json().catch(() => ({}))
    if (!json.ok) throw new Error(`${method} failed: ${json.error ?? res.status}`)
    return json
  }
  await call('chat.dm', { user: payload.member.userId, text: `Welcome to the team, ${payload.member.name}!` })
  await call('channels.addMember', { channel: 'onboarding', users: [payload.member.userId] })
}
