// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The snapshot the app writes for its widgets. Mirrors `AgentGlanceSnapshot` in
// apps/mobile/lib/agent-glance.ts; unknown fields are ignored, so the app can
// add fields without breaking an installed widget.

import Foundation
import SwiftUI

enum GlanceStore {
    /// Keep in sync with GLANCE_APP_GROUP / GLANCE_STORAGE_KEY in lib/glance-storage.ts.
    static let appGroup = "group.ai.shogo.app"
    static let key = "glance"
    /// A snapshot this old is not worth showing as if it were current.
    static let staleAfter: TimeInterval = 6 * 60 * 60

    static func load() -> GlanceSnapshot? {
        guard
            let raw = UserDefaults(suiteName: appGroup)?.string(forKey: key),
            let data = raw.data(using: .utf8)
        else { return nil }
        return try? JSONDecoder().decode(GlanceSnapshot.self, from: data)
    }
}

struct GlanceApproval: Codable, Hashable {
    let messageId: String
    let conversationId: String
    let summary: String
}

struct GlanceAgent: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    /// needs_you, failed, running, queued or done.
    let state: String
    let stateLabel: String
    let detail: String
    /// #rrggbb
    let color: String
    let approval: GlanceApproval?
    /// shogo://agents/<id>
    let link: String
    let updatedAt: Double

    var needsYou: Bool { state == "needs_you" }

    /// What to say under the name: what it wants if it is waiting, else what it is doing.
    var subtitle: String {
        if let approval, !approval.summary.isEmpty { return approval.summary }
        return detail.isEmpty ? stateLabel : detail
    }

    var url: URL { URL(string: link) ?? URL(string: "shogo://")! }
}

struct GlanceSnapshot: Codable, Hashable {
    let version: Int
    /// Milliseconds since 1970.
    let generatedAt: Double
    let workspaceId: String?
    let waiting: Int
    let working: Int
    let agents: [GlanceAgent]

    var generatedDate: Date { Date(timeIntervalSince1970: generatedAt / 1000) }

    static let sample = GlanceSnapshot(
        version: 1,
        generatedAt: Date().timeIntervalSince1970 * 1000,
        workspaceId: nil,
        waiting: 1,
        working: 1,
        agents: [
            GlanceAgent(
                id: "a", name: "Atlas", state: "needs_you", stateLabel: "Waiting for your OK",
                detail: "", color: "#3b5bdb",
                approval: GlanceApproval(messageId: "m", conversationId: "c", summary: "Run npm install"),
                link: "shogo://agents/a", updatedAt: 0
            ),
            GlanceAgent(
                id: "b", name: "Mira", state: "running", stateLabel: "Working",
                detail: "Editing the checkout page", color: "#12b886",
                approval: nil, link: "shogo://agents/b", updatedAt: 0
            ),
        ]
    )
}

extension Color {
    /// `#rrggbb`; anything else falls back to the default blue.
    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let value = UInt32(s, radix: 16) else {
            self = Color(red: 0.23, green: 0.36, blue: 0.86)
            return
        }
        self = Color(
            red: Double((value >> 16) & 0xff) / 255,
            green: Double((value >> 8) & 0xff) / 255,
            blue: Double(value & 0xff) / 255
        )
    }
}
