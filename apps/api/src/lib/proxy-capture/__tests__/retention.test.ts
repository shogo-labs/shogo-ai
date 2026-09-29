import { describe, expect, test } from 'bun:test'
import { pruneProxyTurns } from '../retention'

describe('proxy turn retention', () => {
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
