import { describe, expect, test } from 'bun:test'
import { pruneProxyTurns } from '../retention'

describe('proxy turn retention', () => {
  test('prunes every expired local row regardless of workspace home region', async () => {
    const prevRegion = process.env.REGION_ID
    const prevPeers = process.env.REGION_PEERS
    process.env.REGION_ID = 'eu-frankfurt-1'
    process.env.REGION_PEERS = JSON.stringify([{ id: 'us-ashburn-1', url: 'https://us.example' }])
    try {
      const calls: any[] = []
      const prisma = {
        proxyTurn: {
          deleteMany: async (args: any) => {
            calls.push(args)
            return { count: 2 }
          },
        },
      } as any

      expect(await pruneProxyTurns(prisma)).toBe(2)
      expect(Object.keys(calls[0].where)).toEqual(['lastAt'])
    } finally {
      if (prevRegion === undefined) delete process.env.REGION_ID
      else process.env.REGION_ID = prevRegion
      if (prevPeers === undefined) delete process.env.REGION_PEERS
      else process.env.REGION_PEERS = prevPeers
    }
  })

  test('prunes every expired row in a single-region deployment', async () => {
    const calls: any[] = []
    const prisma = {
      proxyTurn: {
        deleteMany: async (args: any) => {
          calls.push(args)
          return { count: 3 }
        },
      },
    } as any

    expect(await pruneProxyTurns(prisma)).toBe(3)
    expect(calls).toHaveLength(1)
    expect(calls[0].where.lastAt.lt).toBeInstanceOf(Date)
    expect(calls[0].where.workspace).toBeUndefined()
    const ageDays = (Date.now() - calls[0].where.lastAt.lt.getTime()) / 86_400_000
    expect(Math.round(ageDays)).toBe(1095)
  })
})
