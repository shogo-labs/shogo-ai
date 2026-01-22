/**
 * User Operations via shogo.db
 * 
 * Demonstrates: shogo.db.user.* methods
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type UserType = {
  id: string
  email: string
  name: string | null
}

/**
 * Get or create the current user (first user for demo)
 */
export const getCurrentUser = createServerFn({ method: 'GET' }).handler(async () => {
  // For demo: get first user or return null
  const user = await shogo.db.user.findFirst({
    orderBy: { createdAt: 'asc' },
  })
  return user
})

/**
 * Create a new user
 */
export const createUser = createServerFn({ method: 'POST' })
  .inputValidator((data: { email: string; name?: string }) => data)
  .handler(async ({ data }) => {
    const user = await shogo.db.user.create({
      data: {
        email: data.email,
        name: data.name,
      },
    })
    return user
  })
