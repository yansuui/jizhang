import Foundation
import CryptoKit
import SwiftUI

struct AssistantBillFile {
    let name: String
    let data: Data
    var digest: String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    static func read(_ url: URL) throws -> Self {
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        guard ["csv", "xlsx"].contains(url.pathExtension.lowercased()) else { throw AssistantFileError.invalidType }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: 5 * 1_024 * 1_024 + 1) ?? Data()
        guard !data.isEmpty, data.count <= 5 * 1_024 * 1_024 else { throw AssistantFileError.invalidSize }
        return Self(name: url.lastPathComponent, data: data)
    }

    func matches(_ metadata: JSONValue) -> Bool {
        metadata["sha256"].stringValue == digest && metadata["sizeBytes"].intValue == Int64(data.count)
    }
}

enum AssistantFileError: LocalizedError {
    case invalidType, invalidSize, differentFile
    var errorDescription: String? {
        switch self {
        case .invalidType: return "请选择微信 XLSX 或支付宝 CSV 账单。"
        case .invalidSize: return "文件不能为空，且不能超过 5 MB。"
        case .differentFile: return "文件与原预览不一致，请选择生成这张草案时的原文件。"
        }
    }
}

struct AssistantFileSubmission {
    let requestID = UUID().uuidString
    let file: AssistantBillFile
    let text: String
    var body: JSONValue {
        .object(["clientRequestId": .string(requestID), "text": .string(text),
                 "attachment": .object(["source": .string("auto"), "fileName": .string(file.name),
                                         "fileBase64": .string(file.data.base64EncodedString())])])
    }
}

struct AssistantImportSelection {
    var selected = Set<String>()
    var categories: [String: String] = [:]
    var notes: [String: String] = [:]

    static func limitedNote(_ text: String) -> String {
        var count = 0
        return String(text.prefix { character in
            count += String(character).utf16.count
            return count <= 200
        })
    }

    static func rows(_ card: JSONValue) -> [JSONValue] { card["preview"]["rows"].arrayValue ?? [] }
    static func eligible(_ row: JSONValue) -> Bool {
        row["alreadyExists"].boolValue != true && row["ignored"].boolValue != true &&
        (row["amountCents"].intValue ?? 0) > 0 && !(row["id"].stringValue ?? "").isEmpty
    }

    func body(card: JSONValue, file: AssistantBillFile?) -> JSONValue? {
        guard let file, file.matches(card["attachment"]), !selected.isEmpty, selected.count <= 100 else { return nil }
        let allowed = Set(Self.rows(card).filter(Self.eligible).compactMap { $0["id"].stringValue })
        guard selected.isSubset(of: allowed) else { return nil }
        return .object(["fileBase64": .string(file.data.base64EncodedString()),
                        "selectedIds": .array(selected.sorted().map(JSONValue.string)),
                        "categoryOverrides": .object(categories.filter { selected.contains($0.key) && !$0.value.isEmpty }.mapValues(JSONValue.string)),
                        "noteOverrides": .object(notes.filter { selected.contains($0.key) }.mapValues(JSONValue.string))])
    }

    init(body: JSONValue? = nil) {
        selected = Set(body?["selectedIds"].arrayValue?.compactMap(\.stringValue) ?? [])
        categories = body?["categoryOverrides"].objectValue?.compactMapValues(\.stringValue) ?? [:]
        notes = body?["noteOverrides"].objectValue?.compactMapValues(\.stringValue) ?? [:]
    }
}

struct AssistantImportRows: View {
    let card: JSONValue
    @Binding var selection: AssistantImportSelection
    private var categories: [JSONValue] { card["preview"]["categories"].arrayValue ?? [] }

    var body: some View {
        Section("选择导入的账单（\(selection.selected.count) / 100）") {
            Text("逐条核对分类和备注后勾选。已有记录及忽略项不会导入；单次最多选择 100 条。")
                .font(.caption).foregroundStyle(.secondary)
            ForEach(Array(AssistantImportSelection.rows(card).enumerated()), id: \.offset) { _, row in
                if let id = row["id"].stringValue {
                    DisclosureGroup {
                        AssistantPreviewValues(value: row, context: "platform-import")
                        if AssistantImportSelection.eligible(row) {
                            Picker("分类", selection: Binding(get: { selection.categories[id] ?? "" }, set: { selection.categories[id] = $0 })) {
                                Text("使用建议分类").tag("")
                                ForEach(Array(categories.filter { $0["type"].intValue == row["type"].intValue }.enumerated()), id: \.offset) { _, category in
                                    Text(category["name"].stringValue ?? "分类").tag(category["id"].stringValue ?? "")
                                }
                            }
                            TextField("备注", text: Binding(get: { selection.notes[id] ?? row["note"].stringValue ?? "" },
                                                           set: { selection.notes[id] = AssistantImportSelection.limitedNote($0) }), axis: .vertical)
                            Text("备注最多 200 个文本单位，表情可能占多个单位。").font(.caption2).foregroundStyle(.secondary)
                        }
                    } label: {
                        Toggle(isOn: Binding(get: { selection.selected.contains(id) }, set: { value in
                            if value && selection.selected.count < 100 { selection.selected.insert(id) }
                            else { selection.selected.remove(id) }
                        })) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(row["dateLabel"].stringValue ?? "") · \(LedgerFormat.money(row["amountCents"].intValue ?? 0))")
                                Text(row["note"].stringValue ?? "账单").font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                if row["alreadyExists"].boolValue == true { Text("已存在").font(.caption).foregroundStyle(.secondary) }
                                if row["ignored"].boolValue == true { Text("已忽略").font(.caption).foregroundStyle(.secondary) }
                            }
                        }.disabled(!AssistantImportSelection.eligible(row))
                    }
                }
            }
        }
    }
}
