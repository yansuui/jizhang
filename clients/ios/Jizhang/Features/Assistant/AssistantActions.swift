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

/// Labels are shared by read results and confirmation previews. Machine-only
/// fields (revisions, tokens, fingerprints, page envelopes) never become rows.
enum AssistantPreviewFormat {
    static let internalFields: Set<String> = ["fingerprint", "__fingerprint", "expectedRevision", "expectedFundConfigRevision",
        "expectedFundPurposeRevision", "expectedTransactionToken", "transactionToken", "expectedTopologyToken",
        "expectedRefundToken", "previewToken", "token", "contractVersion", "sourceToken", "expectedToken",
        "version", "toolName", "actionId", "operationId", "updatedAt", "createdAt", "conversationId", "generationId",
        "sourceMessageId", "nativeAction", "financialPurposeRevision", "fundPurposeRevision", "fundPurposeSource",
        "fundPurposeStatus", "textProjection", "pageReducedForDisplay", "fullNoteOmitted", "refundDetailsHaveMore",
        "refundLinkedHaveMore", "refundDetailsTotal", "refundLinkedTotal", "sortOrder", "icon", "color"]
    static let labels: [String: String] = [
        "amountCents": "金额", "incomeCents": "收入", "expenseCents": "支出", "balanceCents": "余额",
        "totalCents": "合计", "refundCents": "退款", "availableCents": "可用金额", "date": "日期",
        "startDate": "开始日期", "endDate": "结束日期", "note": "备注", "name": "名称", "type": "类型",
        "categoryName": "分类", "accountName": "账户", "categoryId": "分类", "accountId": "账户",
        "fundPurpose": "资金用途", "financialPurpose": "旧版用途", "tags": "标签", "isRefund": "是否退款",
        "refundLinkedTxIds": "关联支出", "items": "记录", "rows": "明细", "actions": "整理建议", "changes": "变更",
        "before": "修改前", "after": "修改后", "title": "标题", "summary": "说明", "reason": "原因", "warnings": "提示",
        "selectedIds": "选中记录", "actionIds": "选中建议", "count": "数量", "total": "总数",
        "allocations": "分配", "ratios": "比例", "ratiosBps": "比例（万分比）", "purpose": "用途",
        "development": "发展", "emergency": "应急", "enjoyment": "享受", "living": "生活",
        "status": "状态", "transactionId": "账单编号", "source": "来源", "description": "说明",
        "targetAmountCents": "目标金额", "monthlyAmountCents": "每月金额", "remainingCents": "剩余金额",
        "runId": "整理批次", "operationId": "操作编号", "id": "编号", "value": "内容",
        "inserted": "新增数量", "skipped": "跳过数量", "ignored": "忽略数量", "selected": "已选择",
        "initialBalanceCents": "初始余额", "fromAccountId": "转出账户", "toAccountId": "转入账户",
        "parentId": "上级分类", "enabled": "启用", "active": "有效", "cycleStartDay": "周期起始日",
        "salaryCents": "分配收入", "targetCents": "目标金额", "openingCents": "期初金额",
        "limit": "本页条数", "offset": "起始位置", "nextOffset": "后续位置", "hasMore": "还有后续记录",
        "startMonth": "开始月份", "month": "月份", "effectiveMonth": "生效月份", "interval": "间隔",
        "frequency": "频率", "dayOfMonth": "每月日期", "dayOfWeek": "每周日期",
        "transaction": "账单", "transfer": "转账", "category": "分类", "account": "账户", "item": "物品",
        "salary": "工资", "goal": "目标", "rule": "周期规则", "budget": "预算", "record": "记录",
        "settings": "设置", "funds": "资金", "plan": "计划", "deleted": "删除状态", "completed": "已完成",
        "checkedAt": "核对时间", "expiresAt": "过期时间", "confirmedAt": "确认时间", "periodStart": "周期开始",
        "refundSummary": "退款信息", "refundDetails": "退款明细", "kind": "类别", "page": "分页",
        "fileName": "文件名", "sizeBytes": "文件大小", "sha256": "SHA-256", "url": "链接", "links": "链接",
        "what": "内容", "backup": "备份", "model": "模型", "provider": "服务商", "configured": "已配置",
        "message": "说明", "state": "状态", "progress": "进度", "path": "路径", "role": "角色",
        "username": "用户名", "email": "邮箱", "seenAt": "查看时间",
        "refundDetailsPage": "退款明细分页", "refundLinkedTxIdsPage": "关联支出分页"
    ]
    static let dateFields: Set<String> = ["date", "startDate", "endDate", "periodStart", "checkedAt", "confirmedAt",
        "expiresAt", "startedAt", "finishedAt"]
    /// The reading order of a receipt: what, how much, where, when, why.
    static let fieldOrder: [String] = ["type", "amountCents", "incomeCents", "expenseCents", "balanceCents", "totalCents",
        "refundCents", "name", "title", "categoryName", "accountName", "categoryId", "accountId", "fromAccountId",
        "toAccountId", "fromAccountName", "toAccountName", "date", "startDate", "endDate", "note", "fundPurpose",
        "purpose", "financialPurpose", "isRefund", "tags", "status", "deleted", "reason", "summary"]

    static func isInternal(_ key: String) -> Bool {
        let lower = key.lowercased()
        return internalFields.contains(key) || lower.contains("revision") || lower.contains("fingerprint") ||
            lower.contains("token") || lower == "operationid" || lower == "contractversion"
    }

    static func label(_ key: String) -> String { labels[key] ?? key }

    static func ordered(_ keys: [String]) -> [String] {
        keys.filter { !isInternal($0) }.sorted { left, right in
            let l = fieldOrder.firstIndex(of: left) ?? Int.max
            let r = fieldOrder.firstIndex(of: right) ?? Int.max
            return l == r ? left < right : l < r
        }
    }

    static func statusTitle(_ value: String) -> String {
        switch value {
        case "pending": return "待确认"
        case "confirmed": return "已确认"
        case "cancelled": return "已取消"
        case "expired": return "已过期"
        case "running": return "进行中"
        case "complete", "completed": return "已完成"
        case "failed": return "失败"
        case "ready": return "已就绪"
        case "applied": return "已应用"
        case "undone": return "已撤销"
        case "ok": return "正常"
        default: return value
        }
    }

    static func scalar(_ value: JSONValue, key: String, context: String = "", metadata: LedgerMetadata? = nil) -> String? {
        switch value {
        case .string(let value):
            if ["fundPurpose", "purpose", "financialPurpose"].contains(key) {
                return LedgerPurpose(rawValue: value)?.title ?? value
            }
            if key == "status" { return statusTitle(value) }
            if ["categoryId", "parentId"].contains(key) {
                guard let metadata else { return value }
                return metadata.categoryName(value)
            }
            if ["accountId", "fromAccountId", "toAccountId"].contains(key) {
                guard let metadata else { return value }
                return metadata.accountName(value)
            }
            return value.isEmpty ? "未填写" : value
        case .integer(let value):
            if key.hasSuffix("Cents") { return LedgerFormat.money(value) }
            if dateFields.contains(key) {
                if value == 0 { return "未设置" }
                if value > 1_000_000_000_000 { return LedgerFormat.date(value) }
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
    @Environment(\.assistantLedgerMetadata) private var metadata: LedgerMetadata?

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            if let scalar = AssistantPreviewFormat.scalar(value, key: field, context: context, metadata: metadata) {
                if field.isEmpty { Text(scalar).textSelection(.enabled) }
                else {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(AssistantPreviewFormat.label(field)).font(.caption).foregroundStyle(.secondary)
                        Text(scalar).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else if let object = value.objectValue {
                ForEach(AssistantPreviewFormat.ordered(Array(object.keys)), id: \.self) { key in
                    if let child = object[key] {
                        if AssistantPreviewFormat.scalar(child, key: key, context: context, metadata: metadata) != nil {
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
                    if AssistantPreviewFormat.scalar(child, key: field, context: context, metadata: metadata) != nil {
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
