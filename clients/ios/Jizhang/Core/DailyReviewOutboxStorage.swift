import Foundation

@MainActor protocol DailyReviewOutboxStorage: AnyObject {
    func read(_ id: String) throws -> Data?
    func write(_ data: Data, id: String) throws
}

/// A review checkpoint finishes an atomic file write before any generation POST.
@MainActor final class FileDailyReviewOutbox: DailyReviewOutboxStorage {
    private let directory: URL

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Jizhang/DailyReviewOutbox", isDirectory: true)
    }

    func read(_ id: String) throws -> Data? {
        let path = try file(id)
        guard FileManager.default.fileExists(atPath: path.path) else { return nil }
        return try Data(contentsOf: path)
    }

    func write(_ data: Data, id: String) throws {
        let path = try file(id)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: path, options: [.atomic, .completeFileProtection])
    }

    private func file(_ id: String) throws -> URL {
        guard id.range(of: "^[0-9a-f]{64}\\.[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil else {
            throw DailyReviewOutboxError.invalid
        }
        return directory.appendingPathComponent(id + ".json", isDirectory: false)
    }
}

enum DailyReviewOutboxError: Error { case invalid }
