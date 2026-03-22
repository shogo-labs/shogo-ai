// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Default Response Transforms
 *
 * Pre-built transforms for common integrations that return excessively large
 * responses. These are registered on startup and can be overridden by the
 * agent via binding_transform({ action: "create", ... }).
 */

import type { ResponseTransform } from './response-transforms'

/**
 * Gmail FETCH_EMAILS: raw response includes full DKIM/ARC/SPF headers,
 * base64-encoded HTML bodies, and all MIME parts per email — easily 50-100KB
 * per email. This transform extracts just what the agent needs.
 */
const GMAIL_FETCH_EMAILS: ResponseTransform = {
  toolSlug: 'GMAIL_FETCH_EMAILS',
  description: 'Extract email summaries: id, subject, from, to, date, labels, preview (drops headers, payload, base64 bodies)',
  transformFn: `(data) => {
  var msgs = data.messages || data.data?.messages || (Array.isArray(data) ? data : []);
  return {
    emails: msgs.map(function(m) {
      var headers = (m.payload && m.payload.headers) || [];
      var getHeader = function(name) {
        for (var i = 0; i < headers.length; i++) {
          if (headers[i].name === name) return headers[i].value;
        }
        return null;
      };
      return {
        id: m.messageId || m.id,
        subject: getHeader("Subject") || m.subject || "(no subject)",
        from: getHeader("From") || m.from,
        to: getHeader("To") || m.to,
        date: m.messageTimestamp || getHeader("Date"),
        labels: m.labelIds || [],
        hasAttachments: (m.attachmentList && m.attachmentList.length > 0) || false,
        preview: (m.messageText || m.snippet || "").substring(0, 300)
      };
    }),
    count: msgs.length
  };
}`,
  createdAt: Date.now(),
}

const GMAIL_LIST_THREADS: ResponseTransform = {
  toolSlug: 'GMAIL_LIST_THREADS',
  description: 'Extract thread summaries: id, subject, snippet, message count',
  transformFn: `(data) => {
  var threads = data.threads || data.data?.threads || [];
  return {
    threads: threads.map(function(t) {
      return {
        id: t.id,
        snippet: (t.snippet || "").substring(0, 200),
        historyId: t.historyId,
        messageCount: t.messages ? t.messages.length : undefined
      };
    }),
    count: threads.length,
    nextPageToken: data.nextPageToken
  };
}`,
  createdAt: Date.now(),
}

const GITHUB_LIST_ISSUES: ResponseTransform = {
  toolSlug: 'GITHUB_LIST_ISSUES',
  description: 'Extract issue summaries: number, title, state, labels, assignee, created date',
  transformFn: `(data) => {
  var items = data.data?.items || data.items || data.data || (Array.isArray(data) ? data : []);
  return {
    issues: items.map(function(i) {
      return {
        number: i.number,
        title: i.title,
        state: i.state,
        labels: (i.labels || []).map(function(l) { return typeof l === "string" ? l : l.name; }),
        assignee: i.assignee ? (i.assignee.login || i.assignee) : null,
        author: i.user ? i.user.login : null,
        created: i.created_at,
        updated: i.updated_at,
        comments: i.comments
      };
    }),
    total: data.data?.total_count || items.length
  };
}`,
  createdAt: Date.now(),
}

const GITHUB_LIST_PULL_REQUESTS: ResponseTransform = {
  toolSlug: 'GITHUB_LIST_PULL_REQUESTS',
  description: 'Extract PR summaries: number, title, state, author, branch, review status',
  transformFn: `(data) => {
  var items = data.data || (Array.isArray(data) ? data : []);
  return {
    pullRequests: items.map(function(pr) {
      return {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        author: pr.user ? pr.user.login : null,
        head: pr.head ? pr.head.ref : null,
        base: pr.base ? pr.base.ref : null,
        created: pr.created_at,
        updated: pr.updated_at,
        draft: pr.draft || false,
        mergeable: pr.mergeable
      };
    }),
    count: items.length
  };
}`,
  createdAt: Date.now(),
}

const GOOGLECALENDAR_LIST_EVENTS: ResponseTransform = {
  toolSlug: 'GOOGLECALENDAR_LIST_EVENTS',
  description: 'Extract event summaries: id, title, start, end, location, attendees',
  transformFn: `(data) => {
  var items = data.items || data.data?.items || [];
  return {
    events: items.map(function(e) {
      return {
        id: e.id,
        title: e.summary || e.title,
        start: e.start ? (e.start.dateTime || e.start.date) : null,
        end: e.end ? (e.end.dateTime || e.end.date) : null,
        location: e.location,
        status: e.status,
        attendees: (e.attendees || []).map(function(a) { return a.email; }).slice(0, 10),
        organizer: e.organizer ? e.organizer.email : null,
        htmlLink: e.htmlLink
      };
    }),
    count: items.length,
    nextPageToken: data.nextPageToken
  };
}`,
  createdAt: Date.now(),
}

export const DEFAULT_TRANSFORMS: ResponseTransform[] = [
  GMAIL_FETCH_EMAILS,
  GMAIL_LIST_THREADS,
  GITHUB_LIST_ISSUES,
  GITHUB_LIST_PULL_REQUESTS,
  GOOGLECALENDAR_LIST_EVENTS,
]
