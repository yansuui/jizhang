import Foundation
import SwiftUI
import UniformTypeIdentifiers

struct AssistantActionResponse: Decodable {
    struct Action: Decodable {
        let id: String
        let conversationId: String
        let status: String
    }
    let action: Action

    func validate(actionID: String, conversationID: String, confirming: Bool) throws {
        guard action.id == actionID, action.conversationId == conversationID,
              confirming ? action.status == "confirmed" : ["cancelled", "confirmed", "expired"].contains(action.status)
        else { throw AssistantProtocolError.invalidSnapshot }
    }

    static func updating(_ messages: [AssistantMessage], actionID: String, status: String) -> [AssistantMessage] {
        messages.map { message in
            guard var card = message.content.card?.objectValue, card["actionId"]?.stringValue == actionID else { return message }
            card["status"] = .string(status)
            var content = message.content
            content.card = .object(card)
            return AssistantMessage(id: message.id, conversationId: message.conversationId, role: message.role,
                                    kind: message.kind, content: content, createdAt: message.createdAt)
        }
    }
}

/// Labels are shared by read results and confirmation previews. Unknown fields remain inspectable.
enum AssistantPreviewFormat {
    static let internalFields: Set<String> = ["fingerprint", "__fingerprint", "expectedRevision", "expectedFundConfigRevision",
        "expectedFundPurposeRevision", "expectedTransactionToken", "transactionToken", "expectedTopologyToken",
        "expectedRefundToken", "previewToken", "token", "contractVersion", "sourceToken", "expectedToken"]
    static let labels: [String: String] = [
        "amountCents": "金额", "incomeCents": "收入", "expenseCents": "支出", "balanceCents": "余额",
        "totalCents": "合计", "refundCents": "退款", "availableCents": "可用金额", "date": "日期",
        "startDate": "开始日期", "endDate": "结束日期", "note": "备注", "name": "名称", "type": "类型",
        "categoryName": "分类", "accountName": "账户", "categoryId": "分类编号", "accountId": "账户编号",
        "fundPurpose": "资金用途", "tags": "标签", "isRefund": "是否退款", "refundLinkedTxIds": "关联支出",
        "items": "记录", "rows": "明细", "actions": "整理建议", "changes": "变更", "before": "修改前",
        "after": "修改后", "title": "标题", "summary": "说明", "reason": "原因", "warnings": "提示",
        "selectedIds": "选中记录", "actionIds": "选中建议", "count": "数量", "total": "总数",
        "allocations": "分配", "ratios": "比例", "ratiosBps": "比例（万分比）", "purpose": "用途",
        "development": "发展", "emergency": "应急", "enjoyment": "享受", "living": "生活",
        "status": "状态", "transactionId": "账单编号", "source": "来源", "description": "说明",
        "targetAmountCents": "目标金额", "monthlyAmountCents": "每月金额", "remainingCents": "剩余金额",
        "runId": "整理批次", "operationId": "操作编号", "id": "编号", "value": "内容",
        "inserted": "已新增", "skipped": "已跳过", "ignored": "已忽略", "selected": "已选择"
    ]
    static func label(_ key: String) -> String { labels[key] ?? key }
    static func scalar(_ value: JSONValue, key: String, context: String = "") -> String? {
        switch value {
        case .string(let value):
            if ["fundPurpose", "purpose", "financialPurpose"].contains(key) { return LedgerPurpose(rawValue: value)?.title ?? value }
            return value.isEmpty ? "未填写" : value
        case .integer(let value):
            if key.hasSuffix("Cents") { return LedgerFormat.money(value) }
            if key == "date", value > 1_000_000_000_000 {
                return Date(timeIntervalSince1970: Double(value) / 1_000).formatted(date: .abbreviated, time: .omitted)
            }
            if key == "type" {
                if context.hasPrefix("account") { return LedgerFormat.accountType(Int(value)) }
                if ["transaction", "category", "spending", "platform-import"].contains(where: context.hasPrefix) {
                    return value == 0 ? "支出" : value == 1 ? "收入" : String(value)
                }
            }
            return String(value)
        case .number(let value): return String(value)
        case .bool(let value): return value ? "是" : "否"
        case .null: return "未设置"
        default: return nil
        }
    }
}

struct AssistantPreviewValues: View {
    let value: JSONValue
    var field = ""
    var depth = 0
    var context = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            if let scalar = AssistantPreviewFormat.scalar(value, key: field, context: context) {
                if field.isEmpty { Text(scalar).textSelection(.enabled) }
                else {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(AssistantPreviewFormat.label(field)).font(.caption).foregroundStyle(.secondary)
                        Text(scalar).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else if let object = value.objectValue {
                ForEach(object.keys.filter { !AssistantPreviewFormat.internalFields.contains($0) }.sorted(), id: \.self) { key in
                    if let child = object[key] {
                        if AssistantPreviewFormat.scalar(child, key: key, context: context) != nil {
                            nested(child, field: key)
                        } else {
                            DisclosureGroup(AssistantPreviewFormat.label(key)) {
                                nested(child).padding(.top, 8)
                            }
                        }
                    }
                }
            } else if let array = value.arrayValue {
                if array.isEmpty { Text("无").foregroundStyle(.secondary) }
                ForEach(Array(array.enumerated()), id: \.offset) { index, child in
                    if AssistantPreviewFormat.scalar(child, key: field, context: context) != nil {
                        nested(child)
                    } else {
                        DisclosureGroup("第 \(index + 1) 项") {
                            nested(child).padding(.top, 8)
                        }
                    }
                }
            }
        }.font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func nested(_ value: JSONValue, field: String = "") -> AnyView {
        AnyView(AssistantPreviewValues(value: value, field: field, depth: depth + 1, context: context))
    }
}

struct AssistantActionReview: Identifiable {
    let card: JSONValue
    var id: String { card["actionId"].stringValue ?? "" }
}

struct AssistantActionReviewView: View {
    @ObservedObject var store: AssistantStore
    let conversationID: String
    let review: AssistantActionReview
    @Environment(\.dismiss) private var dismiss
    @State private var importSelection = AssistantImportSelection()
    @State private var file: AssistantBillFile?
    @State private var pickingFile = false
    @State private var fileError: String?
    private var isImport: Bool { current["toolName"].stringValue == "platform-import.prepare" }
    private var confirmationBody: JSONValue? {
        if let frozen = store.confirmationBodies[review.id] { return frozen }
        return isImport ? importSelection.body(card: current, file: file) : .object([:])
    }
    private var current: JSONValue {
        store.thread(conversationID).messages.compactMap(\.content.card)
            .first { $0["actionId"].stringValue == review.id } ?? review.card
    }

    var body: some View {
        List {
            Section {
                Text(current["summary"].stringValue ?? "账本操作").font(.headline)
                if let count = current["affected"]["count"].intValue { Text("将处理 \(count) 项") }
                Text("核对下方内容后确认，才会修改账本。").font(.subheadline).foregroundStyle(.secondary)
            }
            Section("操作内容") { AssistantPreviewValues(value: current["values"], context: current["toolName"].stringValue ?? "") }
            if isImport {
                Section("原始账单文件") {
                    if let file { Label(file.name, systemImage: "doc.text") }
                    else { Text("请重新选择原文件，以核对文件是否与预览一致。").font(.subheadline) }
                    Button("选择原文件") { pickingFile = true }
                    if let fileError { Text(fileError).foregroundStyle(.red).font(.caption) }
                }
                AssistantImportRows(card: current, selection: $importSelection)
                    .disabled(store.confirmationBodies[review.id] != nil)
            } else {
                Section("完整预览") { AssistantPreviewValues(value: current["preview"], context: current["toolName"].stringValue ?? "") }
            }
            if let warnings = current["warnings"].arrayValue, !warnings.isEmpty {
                Section("请留意") {
                    ForEach(Array(warnings.enumerated()), id: \.offset) { _, warning in
                        Text(warning.stringValue ?? "").font(.subheadline)
                    }
                }
            }
            if let notice = store.thread(conversationID).actionNotice {
                Section { Text(notice).font(.subheadline).foregroundStyle(.secondary) }
            }
            Section {
                Button {
                    Task {
                        guard let body = confirmationBody else { return }
                        await store.performAction(current, in: conversationID, confirm: true, body: body)
                        if current["status"].stringValue != "pending" { dismiss() }
                    }
                } label: {
                    HStack {
                        Spacer()
                        if store.thread(conversationID).actingID == review.id { ProgressView() }
                        Text(isImport ? "确认导入所选 \(importSelection.selected.count) 条" : "确认执行").fontWeight(.semibold)
                        Spacer()
                    }.frame(minHeight: 36)
                }.disabled(!store.canAct(on: current, in: conversationID) || confirmationBody == nil)
            }
        }
        .navigationTitle("确认账本操作").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        .interactiveDismissDisabled(store.thread(conversationID).actingID != nil)
        .onAppear {
            file = store.cachedFile(for: current)
            importSelection = AssistantImportSelection(body: store.confirmationBodies[review.id])
        }
        .fileImporter(isPresented: $pickingFile, allowedContentTypes: [.commaSeparatedText, UTType(filenameExtension: "xlsx") ?? .data]) { result in
            do {
                let selected = try AssistantBillFile.read(result.get())
                try store.retainFile(selected, for: current)
                file = selected; fileError = nil
            } catch { fileError = error.localizedDescription }
        }
    }
}
