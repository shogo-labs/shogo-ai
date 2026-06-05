// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Email Module Tests
 */

import { describe, test, expect } from 'bun:test'
import {
  interpolate,
  escapeHtml,
  htmlToText,
  EmailTemplateRegistry,
  createTemplateRegistry,
  welcomeTemplate,
  passwordResetTemplate,
  invitationTemplate,
  notificationTemplate,
} from '../templates'
import { createShogoTemplateRegistry } from '../templates/index'
import { EmailError, formatEmailAddress } from '../types'

describe('Email Types', () => {
  describe('formatEmailAddress', () => {
    test('formats string address', () => {
      expect(formatEmailAddress('test@example.com')).toBe('test@example.com')
    })

    test('formats object address without name', () => {
      expect(formatEmailAddress({ email: 'test@example.com' })).toBe('test@example.com')
    })

    test('formats object address with name', () => {
      expect(formatEmailAddress({ email: 'test@example.com', name: 'John Doe' })).toBe(
        '"John Doe" <test@example.com>'
      )
    })
  })

  describe('EmailError', () => {
    test('creates config missing error', () => {
      const error = EmailError.configMissing('host')
      expect(error.code).toBe('config_missing')
      expect(error.message).toContain('host')
    })

    test('creates template not found error', () => {
      const error = EmailError.templateNotFound('unknown')
      expect(error.code).toBe('template_not_found')
      expect(error.message).toContain('unknown')
    })

    test('creates provider not configured error', () => {
      const error = EmailError.providerNotConfigured()
      expect(error.code).toBe('provider_not_configured')
    })
  })
})

describe('Template System', () => {
  describe('interpolate', () => {
    test('replaces simple variables', () => {
      const result = interpolate('Hello {{name}}!', { name: 'Alice' })
      expect(result).toBe('Hello Alice!')
    })

    test('replaces multiple variables', () => {
      const result = interpolate('{{greeting}} {{name}}!', {
        greeting: 'Hi',
        name: 'Bob',
      })
      expect(result).toBe('Hi Bob!')
    })

    test('handles nested variables', () => {
      const result = interpolate('Hello {{user.name}}!', {
        user: { name: 'Charlie' },
      })
      expect(result).toBe('Hello Charlie!')
    })

    test('preserves unmatched variables', () => {
      const result = interpolate('Hello {{unknown}}!', {})
      expect(result).toBe('Hello {{unknown}}!')
    })

    test('converts numbers to strings', () => {
      const result = interpolate('Count: {{count}}', { count: 42 })
      expect(result).toBe('Count: 42')
    })

    test('does not escape values by default', () => {
      const result = interpolate('Hi {{name}}', { name: '<b>x</b>' })
      expect(result).toBe('Hi <b>x</b>')
    })

    test('escapes values when escapeValues is set', () => {
      const result = interpolate('Hi {{name}}', { name: '<b>x</b>' }, { escapeValues: true })
      expect(result).toBe('Hi &lt;b&gt;x&lt;/b&gt;')
    })
  })

  describe('escapeHtml', () => {
    test('escapes HTML special characters', () => {
      expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
        '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;'
      )
    })

    test('leaves safe text unchanged', () => {
      expect(escapeHtml('Alice Smith')).toBe('Alice Smith')
    })
  })

  describe('htmlToText', () => {
    test('strips HTML tags', () => {
      const result = htmlToText('<h1>Hello</h1><p>World</p>')
      expect(result).toContain('Hello')
      expect(result).toContain('World')
      expect(result).not.toContain('<h1>')
      expect(result).not.toContain('<p>')
    })

    test('converts br to newlines', () => {
      const result = htmlToText('Line 1<br>Line 2')
      expect(result).toContain('Line 1\nLine 2')
    })

    test('decodes HTML entities', () => {
      const result = htmlToText('A &amp; B &lt;3 C &gt; D')
      expect(result).toContain('A & B <3 C > D')
    })

    test('removes style tags with content', () => {
      const result = htmlToText('<style>body{color:red}</style>Hello')
      expect(result).toBe('Hello')
    })
  })

  describe('EmailTemplateRegistry', () => {
    test('registers and retrieves templates', () => {
      const registry = new EmailTemplateRegistry()
      registry.register({
        name: 'test',
        subject: 'Test Subject',
        html: '<p>Test body</p>',
      })

      expect(registry.has('test')).toBe(true)
      expect(registry.get('test')?.subject).toBe('Test Subject')
    })

    test('renders template with data', () => {
      const registry = new EmailTemplateRegistry()
      registry.register({
        name: 'greeting',
        subject: 'Hello {{name}}',
        html: '<p>Welcome, {{name}}!</p>',
      })

      const { subject, html } = registry.render('greeting', { name: 'Alice' })
      expect(subject).toBe('Hello Alice')
      expect(html).toBe('<p>Welcome, Alice!</p>')
    })

    test('escapes interpolated values in the HTML body (hyperlink injection)', () => {
      const registry = new EmailTemplateRegistry()
      registry.register({
        name: 'greeting',
        subject: 'Hello {{name}}',
        html: '<p>Welcome, {{name}}!</p>',
      })

      const payload = '"><a href="https://evil.com">click</a>'
      const { subject, html, text } = registry.render('greeting', { name: payload })

      // HTML body must not contain a live anchor tag
      expect(html).not.toContain('<a href="https://evil.com">')
      expect(html).toContain('&lt;a href=&quot;https://evil.com&quot;&gt;')
      // Subject is plain text — not HTML-encoded
      expect(subject).toBe(`Hello ${payload}`)
      // Plain-text body is human-readable, not HTML-encoded
      expect(text).not.toContain('&lt;')
    })

    test('merges defaults with provided data', () => {
      const registry = new EmailTemplateRegistry()
      registry.register({
        name: 'app',
        subject: 'Welcome to {{appName}}',
        html: '<p>{{appName}} by {{author}}</p>',
        defaults: { appName: 'DefaultApp' },
      })

      const { subject, html } = registry.render('app', { author: 'Me' })
      expect(subject).toBe('Welcome to DefaultApp')
      expect(html).toBe('<p>DefaultApp by Me</p>')
    })

    test('throws on unknown template', () => {
      const registry = new EmailTemplateRegistry()
      expect(() => registry.render('unknown', {})).toThrow(EmailError)
    })

    test('lists registered templates', () => {
      const registry = new EmailTemplateRegistry()
      registry.register({ name: 'a', subject: 'A', html: 'A' })
      registry.register({ name: 'b', subject: 'B', html: 'B' })
      expect(registry.list()).toEqual(['a', 'b'])
    })
  })

  describe('createTemplateRegistry', () => {
    test('includes built-in templates', () => {
      const registry = createTemplateRegistry()
      expect(registry.has('welcome')).toBe(true)
      expect(registry.has('password-reset')).toBe(true)
      expect(registry.has('invitation')).toBe(true)
      expect(registry.has('notification')).toBe(true)
    })
  })

  describe('Built-in Templates', () => {
    const registry = createTemplateRegistry()

    test('welcome template renders correctly', () => {
      const { subject, html } = registry.render('welcome', {
        name: 'Alice',
        appName: 'TestApp',
      })
      expect(subject).toBe('Welcome to TestApp!')
      expect(html).toContain('Alice')
      expect(html).toContain('TestApp')
    })

    test('password-reset template renders correctly', () => {
      const { subject, html } = registry.render('password-reset', {
        appName: 'TestApp',
        resetUrl: 'https://example.com/reset',
      })
      expect(subject).toBe('Reset your TestApp password')
      expect(html).toContain('https://example.com/reset')
    })

    test('invitation template renders correctly', () => {
      const { subject, html } = registry.render('invitation', {
        inviterName: 'Bob',
        resourceName: 'My Team',
        acceptUrl: 'https://example.com/accept',
        appName: 'TestApp',
      })
      expect(subject).toBe('Bob invited you to join My Team')
      expect(html).toContain('Bob')
      expect(html).toContain('My Team')
    })

    test('notification template renders correctly', () => {
      const { subject, html } = registry.render('notification', {
        title: 'New Message',
        message: 'You have a new message',
        appName: 'TestApp',
      })
      expect(subject).toBe('New Message')
      expect(html).toContain('You have a new message')
    })
  })

  describe('Shogo Templates (production registry)', () => {
    const registry = createShogoTemplateRegistry()

    test('welcome template escapes a malicious name', () => {
      const { html } = registry.render('welcome', {
        name: '<script>alert(1)</script>',
      })
      expect(html).not.toContain('<script>alert(1)</script>')
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    })

    test('workspace-invite template escapes inviter and workspace names', () => {
      const { html } = registry.render('workspace-invite', {
        inviterName: '<img src=x onerror=alert(1)>',
        workspaceName: '<b>Acme</b>',
        acceptUrl: 'https://app.example.com/accept',
      })
      expect(html).not.toContain('<img src=x onerror=alert(1)>')
      expect(html).not.toContain('<b>Acme</b>')
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
      // Server-generated URLs remain intact in the href
      expect(html).toContain('href="https://app.example.com/accept"')
    })
  })
})
