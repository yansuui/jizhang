import Foundation
import Combine
import UIKit
import CryptoKit

struct NativePhotoPayload {
    let bytes: Data
    let mimeType: String
    let image: UIImage

    /// Normalize orientation, remove metadata and bound uploads while retaining alpha.
    static func prepare(_ data: Data, preserveAlpha: Bool = true) throws -> Self {
        guard data.count <= 20 * 1_024 * 1_024, let original = UIImage(data: data),
              original.size.width > 0, original.size.height > 0,
              original.size.width * original.size.height * original.scale * original.scale <= 40_000_000
        else { throw NativeDataError.invalidFile }
        let alpha = original.cgImage.map {
            [.first, .last, .premultipliedFirst, .premultipliedLast].contains($0.alphaInfo)
        } ?? false
        var edge: CGFloat = 1_600
        for _ in 0..<7 {
            let ratio = min(1, edge / max(original.size.width, original.size.height))
            let size = CGSize(width: max(1, floor(original.size.width * ratio)), height: max(1, floor(original.size.height * ratio)))
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1; format.opaque = !(alpha && preserveAlpha)
            let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                if format.opaque { UIColor.white.setFill(); UIRectFill(CGRect(origin: .zero, size: size)) }
                original.draw(in: CGRect(origin: .zero, size: size))
            }
            let keepAlpha = alpha && preserveAlpha
            if let bytes = keepAlpha ? image.pngData() : image.jpegData(compressionQuality: 0.82),
               bytes.count <= 2 * 1_024 * 1_024 {
                return Self(bytes: bytes, mimeType: keepAlpha ? "image/png" : "image/jpeg", image: image)
            }
            edge *= 0.75
        }
        throw NativeDataError.invalidFile
    }
}

@MainActor final class NativeItemPhotoStore: ObservableObject {
    let api: APIClient
    let itemID: String
    @Published private(set) var existing: UIImage?
    @Published private(set) var draft: NativePhotoPayload?
    @Published private(set) var job = JSONValue.null
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    @Published private(set) var notice: String?
    @Published private(set) var completionReference: JSONValue?
    private var readTicket = UUID()
    private var jobReadTicket = UUID()
    init(api: APIClient, itemID: String) { self.api = api; self.itemID = itemID }
    var photoPath: String { "/items/" + LedgerURL.segment(itemID) + "/photo" }
    var jobID: String? { job["jobId"].stringValue }
    var running: Bool { ["queued", "running"].contains(job["state"].stringValue ?? "") }
    func stage(_ data: Data) {
        guard !busy else { return }
        do { draft = try NativePhotoPayload.prepare(data); error = nil; notice = "照片尚未保存，确认后才会替换物品照片。" }
        catch { self.error = error.localizedDescription }
    }
    func load() async {
        let ticket = UUID(); readTicket = ticket
        completionReference = nil
        do {
            let response = try await api.binary(photoPath, accept: "image/*", maximumBytes: 2 * 1_024 * 1_024)
            try Task.checkCancellation()
            guard readTicket == ticket else { return }
            guard ["image/png", "image/jpeg", "image/webp"].contains(response.mimeType),
                  let image = UIImage(data: response.data) else { throw NativeDataError.invalidResponse }
            existing = image
            completionReference = .object(["kind": .string("item-photo"), "itemId": .string(itemID),
                "operation": .string("viewed"),
                "sha256": .string(SHA256.hash(data: response.data).map { String(format: "%02x", $0) }.joined())])
        } catch {
            guard readTicket == ticket else { return }
            if let failure = error as? APIError, failure.status == 404 { existing = nil }
            else if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }
    func save() async {
        guard !busy, let draft else { return }
        readTicket = UUID()
        busy = true; error = nil; defer { busy = false }
        do {
            _ = try await api.binary(photoPath, method: "PUT", body: draft.bytes, contentType: draft.mimeType)
            try Task.checkCancellation()
            readTicket = UUID()
            existing = draft.image; self.draft = nil; notice = "照片已保存。"; api.notifyLedgerChanged()
            completionReference = .object(["kind": .string("item-photo"), "itemId": .string(itemID),
                "operation": .string("saved"),
                "sha256": .string(SHA256.hash(data: draft.bytes).map { String(format: "%02x", $0) }.joined())])
            if let completedJob = jobID, job["state"].stringValue == "ready" {
                // The photo write is complete; candidate cleanup must not undo its success.
                jobReadTicket = UUID()
                do {
                    _ = try await api.binary("/items/cutouts/" + LedgerURL.segment(completedJob), method: "DELETE")
                    if jobID == completedJob { job = .null }
                } catch { /* Private worker TTL remains the fallback cleanup. */ }
            }
        } catch { if !Task.isCancelled { self.error = "照片保存结果未确认，可保留同一预览重试。" } }
    }
    func remove() async {
        guard !busy else { return }
        readTicket = UUID()
        busy = true; error = nil; defer { busy = false }
        do {
            _ = try await api.binary(photoPath, method: "DELETE")
            try Task.checkCancellation()
            readTicket = UUID()
            existing = nil; notice = "照片已移除。"; api.notifyLedgerChanged()
            completionReference = .object(["kind": .string("item-photo"), "itemId": .string(itemID), "operation": .string("removed")])
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    func startCutout() async {
        guard !busy, !running, let draft else { return }
        jobReadTicket = UUID()
        busy = true; error = nil; defer { busy = false }
        do {
            let value: JSONValue = try await api.rawJSON("/items/cutouts", body: draft.bytes, contentType: draft.mimeType)
            try Task.checkCancellation()
            guard let id = value["jobId"].stringValue, !id.isEmpty else { throw NativeDataError.invalidResponse }
            jobReadTicket = UUID()
            job = .object(["jobId": .string(id), "state": .string("queued"), "candidates": .array([])])
            notice = "已开始生成候选，选中并保存后才会改变物品照片。"
        } catch { if !Task.isCancelled { self.error = "抠图请求未完成，请核对服务状态后再显式重试。" } }
    }
    func refreshJob() async {
        guard let id = jobID else { return }
        let ticket = UUID(); jobReadTicket = ticket
        do {
            let value: JSONValue = try await api.request("/items/cutouts/" + LedgerURL.segment(id))
            try Task.checkCancellation()
            guard jobReadTicket == ticket, jobID == id else { return }
            guard value["jobId"].stringValue == id,
                  ["queued", "running", "ready", "failed", "cancelled"].contains(value["state"].stringValue ?? ""),
                  let candidates = value["candidates"].arrayValue, candidates.count <= 8,
                  candidates.allSatisfy({ $0["id"].stringValue?.isEmpty == false }) else { throw NativeDataError.invalidResponse }
            job = value; error = nil
        } catch { if !Task.isCancelled, jobReadTicket == ticket { self.error = error.localizedDescription } }
    }
    func observe() async {
        for _ in 0..<300 {
            guard !Task.isCancelled, running else { return }
            await refreshJob()
            if error != nil || !running { return }
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
        }
    }
    func cancelJob() async {
        guard !busy, let id = jobID else { return }
        jobReadTicket = UUID()
        busy = true; error = nil; defer { busy = false }
        do {
            _ = try await api.binary("/items/cutouts/" + LedgerURL.segment(id), method: "DELETE")
            try Task.checkCancellation()
            jobReadTicket = UUID()
            job = .object(["jobId": .string(id), "state": .string("cancelled"), "candidates": .array([])])
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    func chooseCandidate(_ candidate: String) async {
        guard !busy, let id = jobID, job["state"].stringValue == "ready",
              job["candidates"].arrayValue?.contains(where: { $0["id"].stringValue == candidate }) == true else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let value = try await api.binary("/items/cutouts/" + LedgerURL.segment(id) + "/candidates/" +
                LedgerURL.segment(candidate) + "/image", accept: "image/png", maximumBytes: 16 * 1_024 * 1_024)
            try Task.checkCancellation()
            guard value.mimeType == "image/png" else { throw NativeDataError.invalidResponse }
            draft = try NativePhotoPayload.prepare(value.data)
            notice = "已选抠图候选，请核对透明背景预览并确认保存。"
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}
