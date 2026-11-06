import Foundation
import Combine
import CryptoKit

enum NativeDataError: LocalizedError {
    case invalidFile, tooManyFiles, invalidResponse, staleReview
    var errorDescription: String? {
        switch self {
        case .invalidFile: return "请选择有效的 CSV/XLSX 文件，并核对大小与编码。"
        case .tooManyFiles: return "一次选择 1–5 个文件，每个不超过 5 MiB，合计不超过 8 MiB。"
        case .invalidResponse: return "返回的数据不完整，请刷新后重试。"
        case .staleReview: return "预览已变化，请重新核对所选记录。"
        }
    }
}

struct NativeBillFile: Identifiable, Equatable {
    let name: String
    let bytes: Data
    let id: String
    init(name: String, bytes: Data) {
        self.name = name; self.bytes = bytes
        id = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    var upload: JSONValue { .object(["fileName": .string(name), "source": .string("auto"), "fileBase64": .string(bytes.base64EncodedString())]) }
    static func read(_ url: URL, limit: Int = 5 * 1_024 * 1_024) throws -> Self {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        guard ["csv", "xlsx"].contains(url.pathExtension.lowercased()) else { throw NativeDataError.invalidFile }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, size <= limit else { throw NativeDataError.invalidFile }
        let data = try Data(contentsOf: url)
        guard !data.isEmpty, data.count <= limit else { throw NativeDataError.invalidFile }
        return Self(name: url.lastPathComponent, bytes: data)
    }
}

/// Pending files and uncertain receipts survive sheet reopening within one API owner.
/// The authenticated feature tree clears this cache on disappearance/account replacement.
@MainActor enum NativeWorkspaceSessions {
    private static var csvStores: [String: NativeCSVImportStore] = [:]
    private static var batchStores: [String: NativeBatchImportStore] = [:]
    private static var photoStores: [String: NativeItemPhotoStore] = [:]
    static func csv(_ api: APIClient, sourceMessageID: String? = nil) -> NativeCSVImportStore {
        let key = api.identity.uuidString + ":" + (sourceMessageID ?? "standalone")
        if let store = csvStores[key] { return store }
        let store = NativeCSVImportStore(api: api, sourceMessageID: sourceMessageID); csvStores[key] = store; return store
    }
    static func batch(_ api: APIClient, conversationID: String?, batchID: String?, sourceMessageID: String? = nil) -> NativeBatchImportStore {
        if let batchID, let store = batchStores.values.first(where: {
            $0.api.identity == api.identity && $0.conversationID == conversationID && $0.batchID == batchID
        }) { return store }
        let key = api.identity.uuidString + ":" + (conversationID ?? "standalone") + ":" + (batchID ?? "new") + ":" + (sourceMessageID ?? "")
        if let store = batchStores[key] { return store }
        let store = NativeBatchImportStore(api: api, conversationID: conversationID, batchID: batchID, sourceMessageID: sourceMessageID)
        batchStores[key] = store; return store
    }
    static func photo(_ api: APIClient, itemID: String) -> NativeItemPhotoStore {
        let key = api.identity.uuidString + ":" + itemID
        if let store = photoStores[key] { return store }
        let store = NativeItemPhotoStore(api: api, itemID: itemID); photoStores[key] = store; return store
    }
    static func clear(apiIdentity: UUID) {
        csvStores = csvStores.filter { !$0.key.hasPrefix(apiIdentity.uuidString + ":") }
        batchStores = batchStores.filter { !$0.key.hasPrefix(apiIdentity.uuidString + ":") }
        photoStores = photoStores.filter { !$0.key.hasPrefix(apiIdentity.uuidString + ":") }
    }
}

@MainActor final class NativeCSVImportStore: ObservableObject {
    let api: APIClient
    @Published private(set) var kind = "transactions"
    @Published private(set) var file: NativeBillFile?
    @Published private(set) var preview: JSONValue?
    @Published private(set) var result: JSONValue?
    @Published private(set) var error: String?
    @Published private(set) var busy = false
    @Published private(set) var uncertain = false
    private var previewRequestID = UUID().uuidString
    private let sourceMessageID: String?
    init(api: APIClient, sourceMessageID: String? = nil) { self.api = api; self.sourceMessageID = sourceMessageID }
    var mayChoose: Bool { !busy && !uncertain }
    func setKind(_ value: String) {
        guard mayChoose, ["transactions", "transfers"].contains(value), value != kind else { return }
        kind = value
        if let file { choose(file) }
    }
    func choose(_ file: NativeBillFile) {
        guard mayChoose else { return }
        self.file = file; preview = nil; result = nil; error = nil
        if let sourceMessageID {
            previewRequestID = "csv-" + SHA256.hash(data: Data((sourceMessageID + ":" + kind + ":" + file.id).utf8))
                .map { String(format: "%02x", $0) }.joined()
        } else { previewRequestID = UUID().uuidString }
    }
    func prepare() async {
        guard !busy, !uncertain, let file, file.bytes.count <= 2 * 1_024 * 1_024,
              let text = String(data: file.bytes, encoding: .utf8), !text.isEmpty else {
            error = "通用账本导入请选择不超过 2 MiB 的 UTF-8 CSV。"; return
        }
        busy = true; error = nil; defer { busy = false }
        do {
            let value: JSONValue = try await api.request("/assistant/data-import/preview", method: "POST", body: .object([
                "kind": .string(kind), "csv": .string(text), "clientRequestId": .string(previewRequestID)
            ]))
            try Task.checkCancellation()
            let draft = value["preview"]
            guard draft["id"].stringValue?.isEmpty == false, draft["kind"].stringValue == kind,
                  let columns = draft["columns"].arrayValue, columns.allSatisfy({ $0.stringValue != nil }),
                  let rows = draft["rows"].arrayValue, rows.allSatisfy({ $0.arrayValue?.allSatisfy { $0.stringValue != nil } == true }),
                  draft["rowsOmitted"].boolValue != nil,
                  let total = draft["totalRows"].intValue, total >= Int64(rows.count),
                  draft["result"]["inserted"].intValue.map({ $0 >= 0 }) == true,
                  draft["result"]["skipped"].intValue.map({ $0 >= 0 }) == true else { throw NativeDataError.invalidResponse }
            preview = draft
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    func confirm() async {
        guard !busy, result == nil, let id = preview?["id"].stringValue,
              let file, let text = String(data: file.bytes, encoding: .utf8) else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let value: JSONValue = try await api.request("/assistant/data-import/" + LedgerURL.segment(id) + "/confirm",
                method: "POST", body: .object(["csv": .string(text)]))
            try Task.checkCancellation()
            guard value["result"]["inserted"].intValue.map({ $0 >= 0 }) == true,
                  value["result"]["skipped"].intValue.map({ $0 >= 0 }) == true else { throw NativeDataError.invalidResponse }
            result = value["result"]; uncertain = false; api.notifyLedgerChanged()
        } catch {
            guard !Task.isCancelled else { return }
            if let failure = error as? APIError, (400..<500).contains(failure.status) {
                uncertain = false; preview = nil; previewRequestID = UUID().uuidString
            } else { uncertain = true }
            self.error = uncertain ? "导入结果尚未确认，请使用原文件和原预览重试核对，避免重复导入。" : error.localizedDescription
        }
    }
}

@MainActor final class NativeExportStore: ObservableObject {
    let api: APIClient
    private let directory: URL
    @Published private(set) var busy = false
    @Published private(set) var file: URL?
    @Published private(set) var error: String?
    private(set) var lastKind: String?
    private var active = false
    private var ticket = UUID()
    init(api: APIClient, directory: URL = FileManager.default.temporaryDirectory) {
        self.api = api; self.directory = directory
    }
    func activate() { active = true }
    func stop() { active = false; ticket = UUID(); busy = false; clean() }
    private func clean() {
        if let file { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        file = nil
    }
    func download(_ kind: String) async {
        guard active, !busy, ["transactions", "salaries", "recurring", "transfers"].contains(kind) else { return }
        let operation = UUID(); ticket = operation; busy = true; error = nil
        defer { if ticket == operation { busy = false } }
        var created: URL?
        do {
            let response = try await api.binary("/export/" + kind + ".csv", accept: "text/csv")
            try Task.checkCancellation()
            guard active, ticket == operation else { return }
            guard response.mimeType == "text/csv", !response.data.isEmpty else { throw NativeDataError.invalidResponse }
            let folder = directory.appendingPathComponent("jizhang-export-" + UUID().uuidString)
            created = folder
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let destination = folder.appendingPathComponent("jizhang-" + kind + ".csv")
            try response.data.write(to: destination, options: [.atomic, .completeFileProtection])
            clean(); lastKind = kind; file = destination; created = nil
        } catch {
            if let created { try? FileManager.default.removeItem(at: created) }
            if !Task.isCancelled, active, ticket == operation { self.error = error.localizedDescription }
        }
    }
}
