import Foundation
import SwiftUI

enum AssistantSpendingSelection {
    /// Only actions the server can still apply. `templateProposals` is deliberately excluded:
    /// the allocation-template surface is retired (migration 022 folds template names into
    /// tags), so an old or cached card that still carries proposals must not become a
    /// selectable action — the server would reject it and the user could not tell why.
    static func actions(_ card: JSONValue) -> [JSONValue] {
        let actions = (card["actions"].arrayValue ?? []).filter {
            ["category", "category-suggestion", "tag"].contains($0["kind"].stringValue ?? "")
        }
        var seen = Set<String>()
        return actions.filter {
            guard let id = $0["actionId"].stringValue, !id.isEmpty else { return false }
            return seen.insert(id).inserted
        }
    }

    static func prompt(card: JSONValue, selected: Set<String>, now: Date = Date()) -> String? {
        guard card["status"].stringValue == "ready", let runID = card["runId"].stringValue, !runID.isEmpty,
              let expires = card["expiresAt"].intValue, expires > Int64(now.timeIntervalSince1970 * 1_000),
              !selected.isEmpty, selected.count <= 100 else { return nil }
        let valid = Set(actions(card).compactMap { $0["actionId"].stringValue })
        guard selected.isSubset(of: valid) else { return nil }
        let payload: JSONValue = .object(["runId": .string(runID), "actionIds": .array(selected.sorted().map(JSONValue.string))])
        guard let data = try? JSONEncoder().encode(payload), let text = String(data: data, encoding: .utf8) else { return nil }
        let prompt = "请为这些我明确选择的历史账单整理建议生成确认草案，其他建议不要应用。选择范围：\(text)。请先展示修改预览，等我确认后执行。"
        return prompt.utf16.count <= 2_000 ? prompt : nil
    }
}

/// Observe a durable background run without starting another paid model request.
@MainActor struct AssistantSpendingRunStatus: View {
    @StateObject private var store: AssistantSpendingRunStore
    let onSuggestion: (String) -> Void
    @State private var showingReview = false
    @State private var refreshTicket = UUID()

    init(api: APIClient, runID: String, initial: JSONValue, onSuggestion: @escaping (String) -> Void) {
        _store = StateObject(wrappedValue: AssistantSpendingRunStore(api: api, runID: runID, initial: initial))
        self.onSuggestion = onSuggestion
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("历史账单整理").font(.headline)
            if store.status == "ready" {
                Label("分析完成，请选择要采用的建议。", systemImage: "checkmark.circle")
                Button {
                    Task { showingReview = await store.openCard() }
                } label: {
                    HStack {
                        if store.opening { ProgressView() }
                        Text("查看整理建议")
                    }
                }.buttonStyle(.bordered).disabled(store.opening)
            } else if store.status == "failed" {
                Text("分析未完成，已保留可用的进度。")
                if store.run["canResume"].boolValue == true {
                    Button("继续未完成的分析") {
                        onSuggestion("请继续历史账单整理任务 \(store.runID)，只处理未完成批次。")
                    }.buttonStyle(.bordered)
                }
            } else if store.status == "cancelled" {
                Text("这次整理已停止，账本没有被整理任务修改。")
            } else if store.observing && store.error == nil {
                ProgressView(store.progressText)
            } else {
                Text(store.progressText).foregroundStyle(.secondary)
            }
            Text("分析只生成建议，选择并确认后才会修改账本。")
                .font(.caption).foregroundStyle(.secondary)
            if let error = store.error { Text(error).font(.caption).foregroundStyle(.secondary) }
            Button(store.observing ? "重新读取进度" : "刷新进度") { refreshTicket = UUID() }
                .font(.caption).disabled(store.opening)
        }
        .task(id: refreshTicket) { await store.observe() }
        .sheet(isPresented: $showingReview) {
            NavigationStack {
                ScrollView {
                    if let card = store.card {
                        AssistantSpendingReview(card: card) { prompt in
                            showingReview = false
                            onSuggestion(prompt)
                        }.padding()
                    }
                }
                .navigationTitle("整理建议")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("关闭") { showingReview = false } } }
            }
        }
    }
}

struct AssistantSpendingReview: View {
    let card: JSONValue
    let onSuggestion: (String) -> Void
    @State private var selected = Set<String>()
    private var actions: [JSONValue] { AssistantSpendingSelection.actions(card) }
    private var prompt: String? { AssistantSpendingSelection.prompt(card: card, selected: selected) }
    private var expired: Bool {
        guard let expiry = card["expiresAt"].intValue else { return true }
        return expiry <= Int64(Date().timeIntervalSince1970 * 1_000)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("整理建议").font(.headline)
            Text("勾选要采用的建议，再生成确认草案。单次最多 100 项；选择内容较多时请分批。备注建议仅供参考。")
                .font(.caption).foregroundStyle(.secondary)
            if actions.isEmpty { Text("没有可应用的整理建议。").font(.subheadline).foregroundStyle(.secondary) }
            ForEach(Array(actions.enumerated()), id: \.offset) { index, action in
                if let actionID = action["actionId"].stringValue {
                    VStack(alignment: .leading, spacing: 6) {
                        Toggle(isOn: Binding(get: { selected.contains(actionID) }, set: { value in
                            if value && selected.count < 100 { selected.insert(actionID) }
                            else { selected.remove(actionID) }
                        })) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(title(action, index: index)).font(.subheadline.weight(.medium))
                                if let reason = action["reason"].stringValue { Text(reason).font(.caption).foregroundStyle(.secondary) }
                            }
                        }.tint(AppTheme.accent)
                        DisclosureGroup("查看修改内容") { AssistantPreviewValues(value: action).padding(.top, 8) }
                            .font(.caption)
                    }.padding(.vertical, 6)
                }
            }
            if let notes = card["noteSuggestions"].arrayValue, !notes.isEmpty {
                DisclosureGroup("备注参考（不会自动修改）") { AssistantPreviewValues(value: .array(notes)).padding(.top, 8) }
            }
            Button("为所选 \(selected.count) 项生成草案") { if let prompt { onSuggestion(prompt) } }
                .buttonStyle(.bordered).disabled(prompt == nil)
            if expired {
                Text("整理建议已过期，请重新分析后再选择。").font(.caption).foregroundStyle(.secondary)
            } else if !selected.isEmpty && prompt == nil {
                Text("所选内容超过单次消息支持的范围，请分批生成草案。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if card["hasMore"].boolValue == true, let runID = card["runId"].stringValue {
                Button("查看下一页建议") {
                    let offset = (card["offset"].intValue ?? 0) + (card["limit"].intValue ?? 100)
                    let payload: JSONValue = .object(["runId": .string(runID), "offset": .integer(offset), "limit": .integer(100)])
                    if let data = try? JSONEncoder().encode(payload), let text = String(data: data, encoding: .utf8) {
                        onSuggestion("请查看这一批历史账单的下一页整理建议：\(text)。只读取，不修改账本。")
                    }
                }.font(.subheadline)
            }
            Text("生成草案前，你还可以在输入框检查所选范围。").font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func title(_ action: JSONValue, index: Int) -> String {
        let date = action["transactionDateLabel"].stringValue ?? "第 \(index + 1) 项"
        let amount = action["transactionAmountCents"].intValue.map(LedgerFormat.money) ?? ""
        let category = action["afterCategoryName"].stringValue ?? action["proposedCategoryName"].stringValue
        let change = category.map { "分类改为\($0)" } ?? "更新标签"
        return "\(date) \(amount) · \(change)"
    }
}
