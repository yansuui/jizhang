import XCTest
import UIKit
@testable import Jizhang

final class NativeWorkspaceTests: XCTestCase {
    override func tearDown() { CoreMockURLProtocol.setHandler(nil); super.tearDown() }

    func testNativeRoutesRejectArbitraryDestinationsAndKeepConversationOwnership() {
        XCTAssertNil(NativeWorkspaceRoute(value: .object(["destination": .string("https://other.example/steal")])))
        XCTAssertNil(NativeWorkspaceRoute(value: .object(["destination": .string("item-photo"), "itemId": .string("")])))
        let a = NativeWorkspaceRoute(destination: .platformImport, conversationID: "a", batchID: "same")
        let b = NativeWorkspaceRoute(destination: .platformImport, conversationID: "b", batchID: "same")
        XCTAssertNotEqual(a.id, b.id)
        XCTAssertEqual(NativeWorkspaceRoute(value: .object(["destination": .string("password")]))?.destination, .password)
    }

    @MainActor func testBinaryUploadKeepsCSRFAndRealBodyWithoutJSONConversion() async throws {
        let payload = Data([0, 255, 1, 2])
        CoreMockURLProtocol.setHandler { request in
            XCTAssertEqual(request.url?.host, "example.com")
            XCTAssertEqual(request.httpMethod, "PUT")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Requested-With"), "fetch")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "image/png")
            XCTAssertEqual(try Self.body(request), payload)
            return try Self.response(request, data: Data(), type: "", status: 204)
        }
        let api = try client(); defer { api.invalidate() }
        let response = try await api.binary("/items/item/photo", method: "PUT", body: payload, contentType: "image/png")
        XCTAssertEqual(response.status, 204)
    }

    @MainActor func testBinaryReadRejectsOversizeAndForeignOrigin() async throws {
        let api = try client(); defer { api.invalidate() }
        CoreMockURLProtocol.setHandler { request in try Self.response(request, data: Data(repeating: 1, count: 20), type: "text/csv") }
        do { _ = try await api.binary("/export/transactions.csv", maximumBytes: 10); XCTFail("Oversized file was accepted") }
        catch { XCTAssertEqual((error as? APIError)?.code, APIError.invalidResponse.code) }
        CoreMockURLProtocol.setHandler { _ in
            let response = try XCTUnwrap(HTTPURLResponse(url: URL(string: "https://foreign.example/file")!, statusCode: 200,
                httpVersion: nil, headerFields: ["Content-Type": "text/csv"]))
            return (response, Data("private".utf8))
        }
        do { _ = try await api.binary("/export/transactions.csv"); XCTFail("Foreign response was accepted") }
        catch { XCTAssertEqual((error as? APIError)?.code, APIError.invalidResponse.code) }
    }

    @MainActor func testCSVPreviewIsReadOnlyAndUncertainConfirmKeepsSameFileAndIdentity() async throws {
        let calls = NativeRequestLog()
        CoreMockURLProtocol.setHandler { request in
            let body = try Self.body(request)
            let path = request.url?.path ?? ""
            if path.hasSuffix("/preview") {
                calls.append("preview", body)
                return try Self.json(request, ["preview": ["id": "preview-one", "kind": "transactions", "expiresAt": 1_900_000_000_000,
                    "columns": ["id"], "rows": [["one"]], "totalRows": 1, "rowsOmitted": false, "result": ["inserted": 1, "skipped": 0]]])
            }
            XCTAssertEqual(path, "/api/v1/assistant/data-import/preview-one/confirm")
            let count = calls.append("confirm", body)
            if count == 1 { throw URLError(.networkConnectionLost) }
            return try Self.json(request, ["result": ["inserted": 1, "skipped": 0]])
        }
        let api = try client(); defer { api.invalidate() }
        let store = NativeCSVImportStore(api: api)
        let file = NativeBillFile(name: "source.csv", bytes: Data("id\none\n".utf8))
        store.choose(file)
        await store.prepare()
        XCTAssertNotNil(store.preview)
        XCTAssertEqual(calls.count("confirm"), 0)
        XCTAssertEqual(api.ledgerRevision, 0)
        await store.confirm()
        XCTAssertTrue(store.uncertain)
        store.choose(NativeBillFile(name: "different.csv", bytes: Data("changed".utf8)))
        XCTAssertEqual(store.file, file)
        await store.confirm()
        XCTAssertFalse(store.uncertain)
        XCTAssertEqual(store.result?["inserted"].intValue, 1)
        XCTAssertEqual(api.ledgerRevision, 1)
        XCTAssertEqual(calls.bodies("confirm").count, 2)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(calls.bodies("confirm").first)),
                       try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(calls.bodies("confirm").last)))
        await store.confirm()
        XCTAssertEqual(calls.count("confirm"), 2)
    }

    @MainActor func testImportSessionsNeverReuseAnotherConversationOrAccount() throws {
        let api = try client()
        let other = try client()
        defer {
            NativeWorkspaceSessions.clear(apiIdentity: api.identity)
            NativeWorkspaceSessions.clear(apiIdentity: other.identity)
            api.invalidate(); other.invalidate()
        }
        let a = NativeWorkspaceSessions.batch(api, conversationID: "a", batchID: nil)
        let b = NativeWorkspaceSessions.batch(api, conversationID: "b", batchID: nil)
        XCTAssertFalse(a === b)
        XCTAssertTrue(a === NativeWorkspaceSessions.batch(api, conversationID: "a", batchID: nil))
        XCTAssertFalse(a === NativeWorkspaceSessions.batch(other, conversationID: "a", batchID: nil))
        NativeWorkspaceSessions.clear(apiIdentity: api.identity)
        XCTAssertFalse(a === NativeWorkspaceSessions.batch(api, conversationID: "a", batchID: nil))
    }

    @MainActor func testPhotoPreparationRetainsTransparentPixelsAndDoesNotUploadUntilSave() async throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24)).image { context in
            context.cgContext.clear(CGRect(x: 0, y: 0, width: 24, height: 24))
            UIColor.red.setFill(); context.cgContext.fill(CGRect(x: 8, y: 8, width: 8, height: 8))
        }
        let bytes = try XCTUnwrap(image.pngData())
        let prepared = try NativePhotoPayload.prepare(bytes)
        XCTAssertEqual(prepared.mimeType, "image/png")
        XCTAssertLessThanOrEqual(prepared.bytes.count, 2 * 1_024 * 1_024)
        let calls = NativeRequestLog()
        CoreMockURLProtocol.setHandler { request in
            calls.append("save", try Self.body(request))
            XCTAssertEqual(request.httpMethod, "PUT")
            XCTAssertEqual(request.url?.path, "/api/v1/items/item-one/photo")
            return try Self.response(request, data: Data(), type: "", status: 204)
        }
        let api = try client(); defer { api.invalidate() }
        let store = NativeItemPhotoStore(api: api, itemID: "item-one")
        store.stage(bytes)
        XCTAssertNotNil(store.draft)
        XCTAssertEqual(calls.count("save"), 0)
        await store.save()
        XCTAssertEqual(calls.count("save"), 1)
        XCTAssertNotNil(store.existing)
        XCTAssertNil(store.draft)
    }

    @MainActor func testMergedBatchUsesExplicitSelectionAndFrozenOriginalsAfterUncertainConfirm() async throws {
        let calls = NativeRequestLog()
        let file = NativeBillFile(name: "alipay.csv", bytes: Data("original-file".utf8))
        let row: [String: Any] = ["itemId": "row-one", "dateLabel": "2026-11-06", "note": "source note",
            "amountCents": 3500, "type": 0, "existing": false, "ignored": false, "isRefund": false]
        let batch: [String: Any] = ["batchId": "batch-one", "conversationId": "conversation-one",
            "version": 1, "status": "prepared", "viewRevision": "revision-one",
            "files": [["fileIndex": 0, "fileName": file.name, "sha256": file.id, "parseStatus": "ok"]],
            "summary": ["totalItems": 1], "analysis": ["state": "idle", "analysisRevision": 0]]
        CoreMockURLProtocol.setHandler { request in
            let path = request.url?.path ?? ""
            if path == "/api/v1/assistant/conversations" {
                return try Self.json(request, ["id": "conversation-one", "title": "Import", "archived": false,
                                              "createdAt": 1, "updatedAt": 1])
            }
            if path.hasSuffix("/import-batches") {
                let body = try JSONDecoder().decode(JSONValue.self, from: Self.body(request))
                XCTAssertEqual(body["analyse"].boolValue, false)
                return try Self.json(request, ["batch": batch])
            }
            if path.hasSuffix("/rows") {
                return try Self.json(request, ["batchId": "batch-one", "version": 1, "viewRevision": "revision-one",
                    "analysisRevision": 0, "total": 1, "items": [row], "nextCursor": NSNull()])
            }
            if path.hasSuffix("/categories") {
                return try Self.json(request, ["batchId": "batch-one", "version": 1, "viewRevision": "revision-one",
                    "categories": [], "items": []])
            }
            if path.hasSuffix("/review") {
                let body = try Self.body(request)
                calls.append("review", body)
                let decoded = try JSONDecoder().decode(JSONValue.self, from: body)
                XCTAssertEqual(decoded["selectedItemIds"], .array([.string("row-one")]))
                XCTAssertEqual(decoded["noteOverrides"]["row-one"], .string(""))
                return try Self.json(request, ["reviewToken": "review-one", "version": 1, "viewRevision": "revision-one",
                    "analysisRevision": 0, "summary": ["selected": 1, "expenseCents": 3500]])
            }
            XCTAssertTrue(path.hasSuffix("/confirm"))
            let count = calls.append("confirm", try Self.body(request))
            if count == 1 { throw URLError(.networkConnectionLost) }
            var confirmed = batch
            confirmed["status"] = "confirmed"; confirmed["result"] = ["inserted": 1]
            return try Self.json(request, ["batch": confirmed, "result": ["inserted": 1]])
        }
        let api = try client(); defer { api.invalidate() }
        let store = NativeBatchImportStore(api: api, conversationID: nil, batchID: nil)
        await store.attach([file])
        XCTAssertEqual(store.rows.count, 1)
        XCTAssertTrue(store.selected.isEmpty)
        XCTAssertEqual(calls.count("review"), 0)
        store.toggle(try XCTUnwrap(store.rows.first), on: true)
        store.setNote("row-one", note: "")
        await store.prepareReview()
        XCTAssertNotNil(store.review)
        XCTAssertEqual(api.ledgerRevision, 0)
        await store.confirm()
        XCTAssertTrue(store.uncertain)
        store.toggle(try XCTUnwrap(store.rows.first), on: false)
        XCTAssertEqual(store.selected, Set(["row-one"]))
        await store.confirm()
        XCTAssertTrue(store.terminal)
        XCTAssertEqual(api.ledgerRevision, 1)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(calls.bodies("confirm").first)),
                       try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(calls.bodies("confirm").last)))
        let frozen = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(calls.bodies("confirm").first))
        XCTAssertEqual(frozen["reviewToken"].stringValue, "review-one")
        XCTAssertEqual(frozen["files"].arrayValue?.first?["fileBase64"].stringValue, file.bytes.base64EncodedString())
    }

    @MainActor func testExportClosedWhileResponseIsPendingDoesNotLeavePrivateFile() async throws {
        let started = expectation(description: "Export request started")
        let gate = NativeResponseGate()
        CoreMockURLProtocol.setHandler { request in
            started.fulfill(); gate.wait()
            return try Self.response(request, data: Data("id,amount\none,3500\n".utf8), type: "text/csv")
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let api = try client(); defer { api.invalidate() }
        let store = NativeExportStore(api: api, directory: directory)
        store.activate()
        let task = Task { await store.download("transactions") }
        await fulfillment(of: [started], timeout: 3)
        store.stop()
        gate.release()
        await task.value
        XCTAssertNil(store.file)
        XCTAssertFalse(store.busy)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
    }

    @MainActor func testOldMissingPhotoReadCannotEraseJustSavedPhoto() async throws {
        let started = expectation(description: "Old photo read started")
        NativeDeferredPhotoProtocol.onRead = { started.fulfill() }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [NativeDeferredPhotoProtocol.self]
        let api = try APIClient(baseURL: ServerAddress.parse("https://example.com"),
            credentialStore: CoreMemoryCredentialStore(), restoreSession: false, configuration: config)
        defer { api.invalidate(); NativeDeferredPhotoProtocol.reset() }
        let store = NativeItemPhotoStore(api: api, itemID: "item-one")
        let image = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).image { context in
            UIColor.red.setFill(); context.cgContext.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
        }
        store.stage(try XCTUnwrap(image.pngData()))
        let pending = Task { await store.load() }
        await fulfillment(of: [started], timeout: 3)
        await store.save()
        XCTAssertNotNil(store.existing)
        NativeDeferredPhotoProtocol.releaseRead()
        await pending.value
        XCTAssertNotNil(store.existing)
        XCTAssertNil(store.error)
    }

    @MainActor func testOldReadyJobReadCannotUndoExplicitCancellation() async throws {
        let started = expectation(description: "Old job read started")
        NativeDeferredPhotoProtocol.onRead = { started.fulfill() }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [NativeDeferredPhotoProtocol.self]
        let api = try APIClient(baseURL: ServerAddress.parse("https://example.com"),
            credentialStore: CoreMemoryCredentialStore(), restoreSession: false, configuration: config)
        defer { api.invalidate(); NativeDeferredPhotoProtocol.reset() }
        let store = NativeItemPhotoStore(api: api, itemID: "item-one")
        let image = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).image { _ in }
        store.stage(try XCTUnwrap(image.pngData()))
        await store.startCutout()
        XCTAssertTrue(store.running)
        let pending = Task { await store.refreshJob() }
        await fulfillment(of: [started], timeout: 3)
        await store.cancelJob()
        NativeDeferredPhotoProtocol.releaseRead()
        await pending.value
        XCTAssertEqual(store.job["state"].stringValue, "cancelled")
    }

    @MainActor private func client() throws -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CoreMockURLProtocol.self]
        return try APIClient(baseURL: ServerAddress.parse("https://example.com"),
            credentialStore: CoreMemoryCredentialStore(), restoreSession: false, configuration: config)
    }
    private static func body(_ request: URLRequest) throws -> Data {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? NativeDataError.invalidResponse }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
    private static func response(_ request: URLRequest, data: Data, type: String, status: Int = 200) throws -> (HTTPURLResponse, Data) {
        (try XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: status, httpVersion: nil,
            headerFields: type.isEmpty ? [:] : ["Content-Type": type])), data)
    }
    private static func json(_ request: URLRequest, _ value: [String: Any]) throws -> (HTTPURLResponse, Data) {
        try response(request, data: JSONSerialization.data(withJSONObject: value), type: "application/json")
    }
}

private final class NativeRequestLog {
    private let lock = NSLock()
    private var values: [String: [Data]] = [:]
    @discardableResult func append(_ key: String, _ body: Data) -> Int {
        lock.lock(); defer { lock.unlock() }
        values[key, default: []].append(body); return values[key]?.count ?? 0
    }
    func bodies(_ key: String) -> [Data] { lock.lock(); defer { lock.unlock() }; return values[key] ?? [] }
    func count(_ key: String) -> Int { bodies(key).count }
}

private final class NativeResponseGate {
    private let condition = NSCondition()
    private var released = false
    func wait() { condition.lock(); defer { condition.unlock() }; while !released { condition.wait() } }
    func release() { condition.lock(); released = true; condition.broadcast(); condition.unlock() }
}

private final class NativeDeferredPhotoProtocol: URLProtocol, @unchecked Sendable {
    static var onRead: (() -> Void)?
    private static let lock = NSLock()
    private static var pending: NativeDeferredPhotoProtocol?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "example.com" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.httpMethod == "GET" {
            Self.lock.lock(); Self.pending = self; let callback = Self.onRead; Self.lock.unlock()
            callback?()
            return
        }
        if request.httpMethod == "POST" {
            emit(status: 202, data: Data(#"{"jobId":"job-a"}"#.utf8))
        } else { emit(status: 204, data: Data()) }
    }
    override func stopLoading() {}
    private func emit(status: Int, data: Data) {
        guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: status,
            httpVersion: nil, headerFields: ["Content-Type": "application/json"]) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !data.isEmpty { client?.urlProtocol(self, didLoad: data) }
        client?.urlProtocolDidFinishLoading(self)
    }
    static func releaseRead() {
        lock.lock(); let value = pending; pending = nil; lock.unlock()
        if value?.request.url?.path.hasSuffix("/photo") == true {
            value?.emit(status: 404, data: Data(#"{"error":{"code":"NOT_FOUND","message":"missing"}}"#.utf8))
        } else {
            value?.emit(status: 200, data: Data(#"{"jobId":"job-a","state":"ready","message":"ready","candidates":[]}"#.utf8))
        }
    }
    static func reset() { lock.lock(); pending = nil; onRead = nil; lock.unlock() }
}
