import { test, expect } from 'bun:test'
import { build } from '../_probe'
test('probe', () => {
  expect(build('a', 5)).toBe('x "a:5"')
  expect(build('a')).toBe('x "a"')
  expect(build()).toBe('x')
})
