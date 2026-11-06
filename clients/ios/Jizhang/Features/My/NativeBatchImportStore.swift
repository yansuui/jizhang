import Foundation
import Combine

/// Dedicated merged-file protocol. Original bytes never enter a model request.
@MainActor final class NativeBatchImportStore: ObservableObject {
    let api: APIClient
    @Published private(set) var conversationID: String?
    @Published private(set) var batchID: String?
    @Published private(set) var batch = JSONValue.null
    @Published private(set) var rows: [JSONValue] = []
    @Published private(set) var categories = JSONValue.null
    @Published private(set) var files: [NativeBillFile] = []
    @Published private(set) var selected = Set<String>()
    @Published private(set) var assignments: [String: JSONValue] = [:]
    @Published private(set) var notes: [String: String] = [:]
    @Published private(set) var approved: [String: JSONValue] = [:]
    @Published private(set) var conflicts: [String: String] = [:]
    @Published private(set) var review: JSONValue?
    @Published private(set) var result: JSONValue?
    @Published private(set) var busy = false
    @Published private(set) var uncertain = false
    @Published var error: String?
    private var nextCursor: String?
    private var frozenConfirm: JSONValue?
    private var createRequestID = UUID().uuidString
    private var analysisRequestID: String?
    private var mutation: (path: String, body: JSONValue, files: [NativeBillFile])?
    private var notified = false
    init(api: APIClient, conversationID: String?, batchID: String?) {
        self.api = api; self.conversationID = conversationID; self.batchID = batchID
    }
    var basePath: String? {
        guard let conversationID, let batchID else { return nil }
        return "/assistant/conversations/" + LedgerURL.segment(conversationID) + "/import-batches/" + LedgerURL.segment(batchID)
    }
    var terminal: Bool { ["confirmed", "cancelled", "expired", "failed"].contains(batch["status"].stringValue ?? "") }
    var editable: Bool { !busy && !uncertain && mutation == nil && !terminal }
    var hasMore: Bool { nextCursor != nil }
    var analysisRunning: Bool { batch["analysis"]["state"].stringValue == "running" }
    var originalsAvailable: Bool { (try? originalFiles()) != nil }

    func attach(_ input: [NativeBillFile]) async {
        guard editable else { return }
        guard (1...5).contains(input.count), input.reduce(0, { $0 + $1.bytes.count }) <= 8 * 1_024 * 1_024,
              Set(input.map(\.id)).count == input.count else { error = NativeDataError.tooManyFiles.localizedDescription; return }
        if batchID != nil {
            let expected = batch["files"].arrayValue ?? []
            guard input.count == expected.count, expected.allSatisfy({ metadata in
                input.contains { $0.id == metadata["sha256"].stringValue && $0.name == metadata["fileName"].stringValue }
            }) else { error = "请重新选择本批次的全部原文件；文件名和内容须与预览一致。"; return }
            files = input; error = nil
            return
        }
        if files.map(\.id) != input.map(\.id) { createRequestID = UUID().uuidString }
        files = input
        await create()
    }

    private func create() async {
        guard !busy, !files.isEmpty else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            if conversationID == nil {
                let value: AssistantConversation = try await api.request("/assistant/conversations", method: "POST")
                guard !value.id.isEmpty, !value.archived else { throw NativeDataError.invalidResponse }
                conversationID = value.id
            }
            guard let conversationID else { throw NativeDataError.invalidResponse }
            let response: JSONValue = try await api.request("/assistant/conversations/" + LedgerURL.segment(conversationID) + "/import-batches",
                method: "POST", body: .object(["files": .array(files.map(\.upload)), "analyse": .bool(false),
                                               "clientRequestId": .string(createRequestID)]))
            try Task.checkCancellation()
            let value = response["batch"]
            guard let id = value["batchId"].stringValue, !id.isEmpty,
                  value["conversationId"].stringValue == conversationID else { throw NativeDataError.invalidResponse }
            batchID = id
            try adopt(value)
            try await loadRows(reset: true)
        } catch { if !Task.isCancelled { error = error.localizedDescription } }
    }

    func refresh() async {
        guard !busy, let basePath else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let response: JSONValue = try await api.request(basePath)
            try Task.checkCancellation()
            try adopt(response["batch"])
            if !terminal && !uncertain { try await loadRows(reset: true) }
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }

    private func adopt(_ value: JSONValue) throws {
        guard value["batchId"].stringValue == batchID, value["conversationId"].stringValue == conversationID,
              let version = value["version"].intValue, version > 0, value["viewRevision"].stringValue?.isEmpty == false,
              value["files"].arrayValue != nil,
              ["draft", "prepared", "reviewed", "confirmed", "cancelled", "expired", "failed"].contains(value["status"].stringValue ?? "")
        else { throw NativeDataError.invalidResponse }
        if value["version"] != batch["version"] || value["viewRevision"] != batch["viewRevision"] ||
            value["analysis"]["analysisRevision"] != batch["analysis"]["analysisRevision"] {
            if !uncertain { invalidateReview() }
        }
        batch = value
        if value["status"].stringValue == "confirmed", value["result"].objectValue != nil {
            result = value["result"]; uncertain = false
            if !notified { notified = true; api.notifyLedgerChanged() }
        }
    }

    private func loadRows(reset: Bool) async throws {
        guard let basePath, let version = batch["version"].intValue else { throw NativeDataError.invalidResponse }
        let page = reset ? nil : nextCursor
        let path = basePath + "/rows" + LedgerURL.query([("limit", "50"), ("includeVersion", String(version)), ("cursor", page)])
        let value: JSONValue = try await api.request(path)
        try Task.checkCancellation()
        guard value["batchId"].stringValue == batchID, value["version"] == batch["version"],
              value["viewRevision"] == batch["viewRevision"], let items = value["items"].arrayValue,
              items.allSatisfy({ $0["itemId"].stringValue?.isEmpty == false &&
                  $0["note"].stringValue != nil && $0["dateLabel"].stringValue?.isEmpty == false &&
                  $0["amountCents"].intValue.map { $0 >= 0 } == true &&
                  [0, 1].contains($0["type"].intValue ?? -1) &&
                  $0["existing"].boolValue != nil && $0["ignored"].boolValue != nil
              }) else { throw NativeDataError.staleReview }
        if reset { rows = items } else {
            let ids = Set(rows.compactMap { $0["itemId"].stringValue })
            guard items.allSatisfy({ !ids.contains($0["itemId"].stringValue ?? "") }) else { throw NativeDataError.staleReview }
            rows += items
        }
        nextCursor = value["nextCursor"].stringValue
        if reset {
            let options: JSONValue = try await api.request(basePath + "/categories" + LedgerURL.query([("includeVersion", String(version))]))
            guard options["batchId"].stringValue == batchID, options["version"] == batch["version"],
                  options["viewRevision"] == batch["viewRevision"], options["categories"].arrayValue != nil,
                  options["items"].arrayValue != nil else { throw NativeDataError.staleReview }
            categories = options
        }
    }

    func next() async {
        guard editable, hasMore else { return }
        busy = true; error = nil; defer { busy = false }
        do { try await loadRows(reset: false) } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    func toggle(_ row: JSONValue, on: Bool) {
        guard editable, let id = row["itemId"].stringValue,
              row["existing"].boolValue != true, row["ignored"].boolValue != true else { return }
        invalidateReview()
        if on {
            if let group = row["conflictGroup"].stringValue {
                for other in rows where other["conflictGroup"].stringValue == group {
                    if let old = other["itemId"].stringValue { selected.remove(old) }
                }
                if let old = conflicts[group] { selected.remove(old) }
                conflicts[group] = id
            }
            selected.insert(id)
        } else {
            selected.remove(id)
            if let group = row["conflictGroup"].stringValue, conflicts[group] == id { conflicts.removeValue(forKey: group) }
        }
    }
    func setAssignment(_ id: String, value: String) {
        guard editable else { return }; invalidateReview()
        if value.hasPrefix("suggestion:") {
            assignments[id] = .object(["kind": .string("suggestion"), "suggestionId": .string(String(value.dropFirst(11)))])
        } else if value.isEmpty { assignments.removeValue(forKey: id) }
        else { assignments[id] = .object(["kind": .string("existing"), "categoryId": .string(value)]) }
    }
    func assignment(_ id: String) -> String {
        guard let value = assignments[id] else { return "" }
        if let id = value["categoryId"].stringValue { return id }
        return value["suggestionId"].stringValue.map { "suggestion:" + $0 } ?? ""
    }
    func setNote(_ id: String, note: String) {
        guard editable else { return }; invalidateReview(); notes[id] = note
    }
    func approve(_ suggestion: JSONValue, on: Bool) {
        guard editable, let id = suggestion["suggestionId"].stringValue else { return }
        invalidateReview()
        if !on { approved.removeValue(forKey: id); return }
        approved[id] = .object(["suggestionId": .string(id), "resolution": .string("create"),
            "reuseCategoryId": .null, "name": suggestion["name"], "type": suggestion["type"], "parentId": suggestion["parentId"]])
    }
    func editApproval(_ id: String, key: String, value: JSONValue) {
        guard editable, var data = approved[id]?.objectValue else { return }
        invalidateReview(); data[key] = value; approved[id] = .object(data)
    }
    private func invalidateReview() { review = nil; frozenConfirm = nil }

    private func originalFiles() throws -> JSONValue {
        guard let expected = batch["files"].arrayValue, !expected.isEmpty else { throw NativeDataError.invalidFile }
        return .array(try expected.map { metadata in
            guard let index = metadata["fileIndex"].intValue,
                  let file = files.first(where: { $0.id == metadata["sha256"].stringValue && $0.name == metadata["fileName"].stringValue })
            else { throw NativeDataError.invalidFile }
            return .object(["fileIndex": .integer(index), "fileBase64": .string(file.bytes.base64EncodedString())])
        })
    }
    func prepareReview() async {
        guard editable, !analysisRunning, !selected.isEmpty, let basePath else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let originals = try originalFiles()
            let value: JSONValue = try await api.request(basePath + "/review", method: "POST", body: .object([
                "version": batch["version"], "analysisRevision": batch["analysis"]["analysisRevision"],
                "viewRevision": batch["viewRevision"], "selectedItemIds": .array(selected.sorted().map(JSONValue.string)),
                "categoryAssignments": .object(assignments.filter { selected.contains($0.key) }),
                "noteOverrides": .object(notes.filter { selected.contains($0.key) }.mapValues(JSONValue.string)),
                "approvedCategories": .array(approved.keys.sorted().compactMap { approved[$0] }),
                "conflictDecisions": .array(conflicts.keys.sorted().map { .object(["conflictGroup": .string($0), "chosenItemId": .string(conflicts[$0]!)]) })
            ]))
            try Task.checkCancellation()
            guard value["reviewToken"].stringValue?.isEmpty == false,
                  value["version"] == batch["version"], value["viewRevision"] == batch["viewRevision"],
                  value["summary"]["selected"].intValue == Int64(selected.count) else { throw NativeDataError.staleReview }
            review = value
            frozenConfirm = .object(["reviewToken": value["reviewToken"], "expectedVersion": value["version"], "files": originals])
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    func confirm() async {
        guard !busy, result == nil, let basePath, let frozenConfirm else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let response: JSONValue = try await api.request(basePath + "/confirm", method: "POST", body: frozenConfirm)
            try Task.checkCancellation()
            try adopt(response["batch"])
            guard batch["status"].stringValue == "confirmed", result != nil else { throw NativeDataError.invalidResponse }
        } catch {
            guard !Task.isCancelled else { return }
            if let failure = error as? APIError, (400..<500).contains(failure.status) {
                uncertain = false; invalidateReview()
                self.error = error.localizedDescription
            } else {
                uncertain = true; self.error = "导入结果尚未确认。请核对原批次或重试同一确认，所选内容已锁定。"
            }
        }
    }
    func analyse() async {
        guard editable, let basePath else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let originals = try originalFiles()
            let key = analysisRequestID ?? UUID().uuidString
            analysisRequestID = key
            let response: JSONValue = try await api.request(basePath + "/analyse", method: "POST",
                body: .object(["clientRequestId": .string(key), "files": originals]))
            try Task.checkCancellation(); try adopt(response["batch"])
            analysisRequestID = nil; try await loadRows(reset: true)
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    func duplicates(_ row: JSONValue, cursor: String? = nil) async throws -> JSONValue {
        guard let basePath, let id = row["itemId"].stringValue else { throw NativeDataError.invalidResponse }
        return try await api.request(basePath + "/rows/" + LedgerURL.segment(id) + "/duplicates" +
                                    LedgerURL.query([("limit", "20"), ("cursor", cursor)]))
    }
    func mutateFiles(index: Int64, replacement: NativeBillFile?) async {
        guard editable, let basePath, let meta = batch["files"].arrayValue else { return }
        do {
            _ = try originalFiles()
            var resulting: [NativeBillFile] = []
            for entry in meta {
                if entry["fileIndex"].intValue == index {
                    if let replacement { resulting.append(replacement) }
                } else if let file = files.first(where: { $0.id == entry["sha256"].stringValue }) { resulting.append(file) }
            }
            guard !resulting.isEmpty, resulting.reduce(0, { $0 + $1.bytes.count }) <= 8 * 1_024 * 1_024 else { throw NativeDataError.tooManyFiles }
            let path = basePath + "/files/" + String(index) + (replacement == nil ? "/remove" : "/replace")
            let body: JSONValue = .object(["expectedVersion": batch["version"], "clientRequestId": .string(UUID().uuidString),
                                           "files": .array(resulting.map(\.upload))])
            mutation = (path, body, resulting)
            await retryMutation()
        } catch { self.error = error.localizedDescription }
    }
    func retryMutation() async {
        guard !busy, let mutation else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let response: JSONValue = try await api.request(mutation.path, method: "POST", body: mutation.body)
            try Task.checkCancellation(); try adopt(response["batch"])
            files = mutation.files; self.mutation = nil
            selected = []; assignments = [:]; notes = [:]; conflicts = [:]; approved = [:]
            try await loadRows(reset: true)
        } catch {
            if let failure = error as? APIError, (400..<500).contains(failure.status) { self.mutation = nil }
            if !Task.isCancelled { self.error = "文件变更未完成，请刷新或重试原变更。" }
        }
    }
    var mutationPending: Bool { mutation != nil }
    func startNew() {
        guard terminal, !busy else { return }
        batchID = nil; batch = .null; rows = []; categories = .null; files = []
        selected = []; assignments = [:]; notes = [:]; approved = [:]; conflicts = [:]
        invalidateReview(); result = nil; error = nil; nextCursor = nil
        createRequestID = UUID().uuidString; analysisRequestID = nil; mutation = nil; notified = false
    }
    func cancel() async {
        guard editable, let basePath else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let value: JSONValue = try await api.request(basePath + "/cancel", method: "POST",
                body: .object(["expectedVersion": batch["version"], "clientRequestId": .string("cancel-" + (batchID ?? ""))]))
            try Task.checkCancellation(); try adopt(value["batch"])
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}
