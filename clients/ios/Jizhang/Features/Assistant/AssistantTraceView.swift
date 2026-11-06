import Foundation
import SwiftUI

/// One diagnostic step of a generation, as reported by the server trace endpoint.
///
/// The trace explains *where* a reply stopped: which tool ran, with which (summarised)
/// arguments, how long it took and whether it succeeded. It deliberately carries no model
/// reasoning and no ledger content, so it is safe to persist and display verbatim.
struct AssistantTraceEntry: Decodable, Identifiable, Equatable {
    let id: String
    let step: Int
    let kind: String
    let toolName: String?
    let argumentSummary: String?
    let status: String
    let startedAt: Int64
    let finishedAt: Int64?

    var isFailed: Bool { status == "failed" }
    var isRunning: Bool { status == "running" }

    /// Wall-clock duration of the step; nil while it is still running.
    var duration: Double? {
        guard let finishedAt, finishedAt >= startedAt else { return nil }
        return Double(finishedAt - startedAt) / 1_000
    }

    var title: String {
        switch kind {
        case "tool": return toolName ?? "工具调用"
        case "result": return "生成回复"
        case "error": return "生成失败"
        default: return "处理中"
        }
    }

    var systemImage: String {
        switch kind {
        case "tool": return "wrench.and.screwdriver"
        case "result": return "text.bubble"
        case "error": return "exclamationmark.triangle"
        default: return "ellipsis.circle"
        }
    }

    var statusLabel: String {
        if isRunning { return "进行中" }
        if isFailed { return "失败" }
        return duration.map { String(format: "%.1fs", $0) } ?? "完成"
    }

    /// Compact detail line: the argument summary, then the failure marker when applicable.
    var detail: String? {
        var parts: [String] = []
        if let argumentSummary, !argumentSummary.isEmpty { parts.append(argumentSummary) }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }
}

struct AssistantTraceItems: Decodable { let items: [AssistantTraceEntry] }

/// Reads the diagnostic trace for one generation.
///
/// The trace is *diagnostic*: a failed request must never disturb the conversation, so this
/// store keeps its own error separate from the thread's notice and simply stops showing a
/// timeline it could not load.
@MainActor final class AssistantTraceStore: ObservableObject {
    let api: APIClient
    let conversationID: String
    let generationID: String
    @Published private(set) var entries: [AssistantTraceEntry] = []
    @Published private(set) var loading = false
    @Published private(set) var loaded = false
    private var ticket = UUID()

    init(api: APIClient, conversationID: String, generationID: String) {
        self.api = api
        self.conversationID = conversationID
        self.generationID = generationID
    }

    var isEmpty: Bool { entries.isEmpty }
    var hasFailure: Bool { entries.contains(where: \.isFailed) }

    func load() async {
        let current = UUID()
        ticket = current
        loading = true
        defer { if ticket == current { loading = false } }
        do {
            let path = AssistantPath.conversation(conversationID)
                + "/generations/\(AssistantPath.segment(generationID))/trace"
            let response: AssistantTraceItems = try await api.request(path)
            guard ticket == current, !Task.isCancelled else { return }
            entries = response.items
            loaded = true
        } catch {
            // Diagnostics are optional: keep whatever was already shown and stop loading.
            guard ticket == current, !Task.isCancelled else { return }
        }
    }
}

/// Collapsible execution trace shown under an assistant reply.
///
/// Collapsed by default so normal conversations stay clean; it opens automatically when a
/// step failed, which is exactly the moment the user needs to know where the reply stopped.
struct AssistantTraceView: View {
    @StateObject private var store: AssistantTraceStore
    @State private var expanded: Bool

    init(api: APIClient, conversationID: String, generationID: String, autoExpand: Bool) {
        _store = StateObject(wrappedValue: AssistantTraceStore(
            api: api, conversationID: conversationID, generationID: generationID))
        _expanded = State(initialValue: autoExpand)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.easeOut(duration: 0.18)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.semibold))
                    Text(summary).font(.caption.weight(.medium))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(expanded ? "收起执行步骤" : "展开执行步骤")

            if expanded {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(store.entries) { entry in
                        HStack(alignment: .top, spacing: 7) {
                            Image(systemName: entry.systemImage)
                                .font(.caption2)
                                .foregroundStyle(entry.isFailed ? Color.orange : Color.secondary)
                                .frame(width: 14, alignment: .center)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 5) {
                                    Text(entry.title).font(.caption.weight(.medium))
                                    Text(entry.statusLabel).font(.caption2)
                                        .foregroundStyle(entry.isFailed ? Color.orange : Color.secondary)
                                }
                                if let detail = entry.detail {
                                    Text(detail).font(.caption2).foregroundStyle(.tertiary)
                                        .lineLimit(2).textSelection(.enabled)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                    }
                }
                .padding(.leading, 2)
                .transition(.opacity)
            }
        }
        .task { await store.load() }
    }

    private var summary: String {
        if store.entries.isEmpty { return store.loading ? "正在读取执行步骤…" : "无执行步骤记录" }
        let failed = store.entries.filter(\.isFailed).count
        return failed > 0 ? "执行步骤 · \(store.entries.count) 步 · \(failed) 步失败"
                          : "执行步骤 · \(store.entries.count) 步"
    }
}
