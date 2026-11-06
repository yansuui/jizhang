import Foundation
import Combine

/// Observing progress is read-only and never starts another model generation or analysis.
@MainActor final class AssistantSpendingRunStore: ObservableObject {
    let api: APIClient
    let runID: String
    let conversationID: String?
    @Published private(set) var run: JSONValue
    @Published private(set) var card: JSONValue?
    @Published private(set) var error: String?
    @Published private(set) var observing = false
    @Published private(set) var opening = false
    private let pollInterval: Duration
    private let maximumReads: Int
    private var observation = UUID()
    private var resumeRequestID = UUID().uuidString

    init(api: APIClient, runID: String, initial: JSONValue, conversationID: String? = nil,
         pollInterval: Duration = .seconds(3), maximumReads: Int = 300) {
        self.api = api; self.runID = runID
        self.conversationID = conversationID
        self.pollInterval = pollInterval; self.maximumReads = max(1, maximumReads)
        run = Self.valid(initial, for: runID) ? initial : .null
    }

    var status: String? { run["status"].stringValue }
    var failureText: String {
        switch run["errorCode"].stringValue {
        case "AI_PROVIDER_TIMEOUT": return "分析请求超时，已完成的进度仍可保留。"
        case "AI_RESPONSE_INVALID": return "模型返回的整理格式无法识别，请核对模型配置后继续。"
        case "AI_PROVIDER_ERROR": return "暂时无法连接分析服务，请稍后继续。"
        case "AI_ORGANIZATION_INTERRUPTED": return "分析被中断，可继续处理尚未完成的批次。"
        case "AI_ORGANIZATION_CONFLICT": return "账单已发生变化，请重新分析当前范围。"
        default: return "分析未完成，请核对任务状态后继续。"
        }
    }
    var progressText: String {
        guard let complete = run["completedCount"].intValue, let total = run["eligibleCount"].intValue else {
            return "正在读取整理进度…"
        }
        return "已分析 \(complete) / \(total) 笔"
    }

    func observe() async {
        let ticket = UUID()
        observation = ticket; observing = true; error = nil
        defer { if observation == ticket { observing = false } }
        var failures = 0
        for index in 0..<maximumReads {
            guard !Task.isCancelled, observation == ticket else { return }
            do {
                let value: JSONValue = try await api.request("/ai/organization-runs/" + LedgerURL.segment(runID))
                guard !Task.isCancelled, observation == ticket else { return }
                guard Self.valid(value, for: runID) else { throw LedgerDataError.invalidResponse }
                run = value; error = nil; failures = 0
                if status != "running" { return }
            } catch is CancellationError { return }
            catch {
                guard !Task.isCancelled, observation == ticket else { return }
                self.error = "进度暂时无法读取，可刷新重试；不会重新启动分析。"
                failures += 1
                if let failure = error as? APIError, [401, 403, 404].contains(failure.status) { return }
                if failures >= 3 { return }
            }
            if index + 1 < maximumReads {
                do { try await Task.sleep(for: pollInterval) } catch { return }
            }
        }
        if !Task.isCancelled, observation == ticket, status == "running", error == nil {
            error = "已暂停自动刷新，可手动查看最新进度。"
        }
    }

    func openCard() async -> Bool {
        guard !opening else { return false }
        opening = true
        defer { opening = false }
        do {
            let value: JSONValue
            if let conversationID {
                let response: JSONValue = try await api.request(AssistantWorkspacePath.base(conversationID) + "/organization/card", method: "POST",
                    body: .object(["runId": .string(runID), "offset": .integer(0), "limit": .integer(30)]))
                value = response["result"]["data"]
            } else { value = try await api.request("/ai/organization-runs/" + LedgerURL.segment(runID) + "/card") }
            guard !Task.isCancelled else { return false }
            guard value["runId"].stringValue == runID, value["status"].stringValue == "ready",
                  value["actions"].arrayValue != nil else { throw LedgerDataError.invalidResponse }
            card = value; error = nil
            return true
        } catch {
            if !Task.isCancelled { self.error = "建议暂时无法读取，请重试查看。" }
            return false
        }
    }

    func resume() async {
        guard !opening, run["canResume"].boolValue == true else { return }
        opening = true; defer { opening = false }
        do {
            let value: JSONValue = try await api.request("/ai/organization-runs/" + LedgerURL.segment(runID) + "/resume", method: "POST",
                body: .object(["clientRequestId": .string(resumeRequestID)]))
            guard !Task.isCancelled, Self.valid(value, for: runID) else { return }
            run = value; error = nil; resumeRequestID = UUID().uuidString
        } catch { if !Task.isCancelled { self.error = "继续分析的结果待核对，可刷新进度或重试相同请求。" } }
    }

    private static func valid(_ value: JSONValue, for id: String) -> Bool {
        guard value["runId"].stringValue == id,
              ["running", "ready", "failed", "cancelled"].contains(value["status"].stringValue ?? ""),
              let total = value["eligibleCount"].intValue, let complete = value["completedCount"].intValue,
              total >= 0, total <= 500, complete >= 0, complete <= total else { return false }
        return true
    }
}
