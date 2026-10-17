// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The wording of the channel notice recording a membership change. Pure and
 * dependency-free so it can be unit tested without a database.
 */

/**
 * How a membership notice names its channel: Slack's `#channel`, or a padlock
 * for the private ones the notice is warning about.
 */
export function membershipChannelLabel(kind: string, name: string): string {
  return kind === 'private' ? `🔒 ${name}` : `#${name}`
}

/**
 * The channel line Slack posts when someone is added — "Sam was added to
 * #growth by Alex." Names arrive already resolved: this is a record of what
 * happened rather than a notification, so nothing here is a `<@u:…>` token and
 * `postMessage` keeps system mentions off, meaning no badge is raised.
 */
export function addedMembersNoticeText(addedNames: string[], actorName: string | null, channel: string): string {
  const count = addedNames.length
  const who = count === 1
    ? addedNames[0]
    : `${addedNames[0]} and ${count - 1} other${count === 2 ? '' : 's'}`
  const verb = count === 1 ? 'was' : 'were'
  return actorName ? `${who} ${verb} added to ${channel} by ${actorName}.` : `${who} ${verb} added to ${channel}.`
}
