// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// "What are my agents doing": Home Screen (small, medium) and Lock Screen
// (circular, rectangular). Tapping an agent opens `shogo://agents/<id>`.

import SwiftUI
import WidgetKit

struct GlanceEntry: TimelineEntry {
    let date: Date
    let snapshot: GlanceSnapshot?

    /// No snapshot yet, or an old one: say so rather than show stale news.
    var isStale: Bool {
        guard let snapshot else { return true }
        return date.timeIntervalSince(snapshot.generatedDate) > GlanceStore.staleAfter
    }
}

struct GlanceProvider: TimelineProvider {
    func placeholder(in context: Context) -> GlanceEntry {
        GlanceEntry(date: Date(), snapshot: .sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (GlanceEntry) -> Void) {
        completion(GlanceEntry(date: Date(), snapshot: context.isPreview ? .sample : GlanceStore.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GlanceEntry>) -> Void) {
        let now = Date()
        let snapshot = GlanceStore.load()
        var entries = [GlanceEntry(date: now, snapshot: snapshot)]
        // Flip to the "open Shogo" state on its own once the snapshot goes stale.
        if let snapshot {
            let staleAt = snapshot.generatedDate.addingTimeInterval(GlanceStore.staleAfter + 1)
            if staleAt > now { entries.append(GlanceEntry(date: staleAt, snapshot: snapshot)) }
        }
        // The app reloads the widget on every change; this is only a backstop.
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(15 * 60))))
    }
}

private let panel = Color(red: 0.086, green: 0.09, blue: 0.114)

private func headline(_ entry: GlanceEntry) -> String {
    guard let s = entry.snapshot, !entry.isStale else { return "Open Shogo" }
    if s.waiting > 0 { return s.waiting == 1 ? "1 needs you" : "\(s.waiting) need you" }
    if s.working > 0 { return s.working == 1 ? "1 working" : "\(s.working) working" }
    return "All quiet"
}

private func lead(_ entry: GlanceEntry) -> GlanceAgent? {
    guard !entry.isStale else { return nil }
    return entry.snapshot?.agents.first
}

private func glow(for entry: GlanceEntry) -> Color {
    guard let agent = lead(entry) else { return Color(hex: "#3b5bdb") }
    return Color(hex: agent.color)
}

private struct Dot: View {
    let agent: GlanceAgent
    var body: some View {
        Circle()
            .fill(Color(hex: agent.color))
            .frame(width: 8, height: 8)
            .overlay {
                if agent.needsYou { Circle().stroke(Color.orange, lineWidth: 2).frame(width: 14, height: 14) }
            }
    }
}

private struct AgentRowView: View {
    let agent: GlanceAgent
    var body: some View {
        HStack(spacing: 8) {
            Dot(agent: agent).frame(width: 14)
            VStack(alignment: .leading, spacing: 1) {
                Text(agent.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(agent.subtitle)
                    .font(.caption)
                    .foregroundStyle(agent.needsYou ? Color.orange : Color.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
    }
}

struct SmallView: View {
    let entry: GlanceEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(headline(entry)).font(.title3.weight(.bold)).lineLimit(2).minimumScaleFactor(0.8)
            Spacer(minLength: 0)
            if let agent = lead(entry) {
                AgentRowView(agent: agent)
            } else {
                Text("Your agents appear here").font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetURL(lead(entry)?.url ?? URL(string: "shogo://")!)
    }
}

struct MediumView: View {
    let entry: GlanceEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(headline(entry)).font(.headline)
            if let agents = entry.snapshot?.agents, !entry.isStale, !agents.isEmpty {
                ForEach(Array(agents.prefix(3))) { agent in
                    Link(destination: agent.url) { AgentRowView(agent: agent) }
                }
                Spacer(minLength: 0)
            } else {
                Spacer(minLength: 0)
                Text("Your agents appear here").font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

struct CircularView: View {
    let entry: GlanceEntry
    var body: some View {
        let count = entry.isStale ? 0 : (entry.snapshot?.waiting ?? 0)
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: count > 0 ? "hand.raised.fill" : "sparkles").font(.caption)
                Text(count > 0 ? "\(count)" : "\(entry.snapshot?.working ?? 0)").font(.headline)
            }
        }
        .widgetURL(lead(entry)?.url ?? URL(string: "shogo://")!)
    }
}

struct RectangularView: View {
    let entry: GlanceEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(headline(entry)).font(.headline).widgetAccentable()
            if let agents = entry.snapshot?.agents, !entry.isStale {
                ForEach(Array(agents.prefix(2))) { agent in
                    Text("\(agent.name): \(agent.subtitle)").font(.caption).lineLimit(1)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(lead(entry)?.url ?? URL(string: "shogo://")!)
    }
}

struct AgentsWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry

    var body: some View {
        Group {
            switch family {
            case .systemMedium: MediumView(entry: entry)
            case .accessoryCircular: CircularView(entry: entry)
            case .accessoryRectangular: RectangularView(entry: entry)
            default: SmallView(entry: entry)
            }
        }
        .foregroundStyle(.white)
        .containerBackground(for: .widget) {
            LinearGradient(
                colors: [glow(for: entry).opacity(0.35), panel],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .background(panel)
        }
    }
}

struct AgentsWidget: Widget {
    let kind = "ShogoAgents"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: GlanceProvider()) { entry in
            AgentsWidgetView(entry: entry)
        }
        .configurationDisplayName("Agents")
        .description("See which agents are waiting on you and which are working.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}
