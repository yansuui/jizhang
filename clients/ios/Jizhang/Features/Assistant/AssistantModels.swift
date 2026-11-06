import Foundation

struct AssistantItems<Item: Decodable>: Decodable {
    let items: [Item]
}

struct AssistantConversation: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let archived: Bool
    let createdAt: Int64
    let updatedAt: Int64

    var displayTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "新对话" : title }
    var updatedDate: Date { Date(timeIntervalSince1970: Double(updatedAt) / 1_000) }
}

struct AssistantFault: Codable, Equatable {
    let code: String
    let message: String

    var displayMessage: String {
        switch code {
        case "AI_NOT_CONFIGURED": return "请先完成 AI 配置并启用。"
        case "AI_ENCRYPTION_KEY_REQUIRED": return "服务器尚未设置 AI 密钥加密，请先完成服务器配置。"
        case "AI_SECRET_UNAVAILABLE": return "保存的 API Key 当前不可用，请检查 AI 配置。"
        case "AI_PROVIDER_TIMEOUT": return "AI 回复超时，请稍后再试。"
        case "AI_PROVIDER_ERROR": return "AI 服务暂时不可用，请检查配置或稍后再试。"
        case "AI_RESPONSE_INVALID": return "AI 返回的内容无法识别，请检查模型和接口协议。"
        case "ASSISTANT_CHOICE_STALE": return "这个问题已经更新，请刷新对话后继续。"
        case "ASSISTANT_GENERATION_ACTIVE": return "这段对话仍在生成回复，请等待或先停止。"
        case "ASSISTANT_STREAM_BOUNDS":
            // Only fixed, server-owned sentences may select a specific explanation.
            // Never display arbitrary provider bodies or internal exception messages.
            return Self.safeStreamMessages[message] ?? "本次回复未能完成，可以查看已有内容后重新提问。"
        default: return "本次请求未能完成，请刷新核对后重试。"
        }
    }

    private static let safeStreamMessages: [String: String] = [
        "AI 响应超时，本次生成已中断。": "AI 服务响应超时，请稍后重试。",
        "暂时无法连接 AI 服务，本次生成已中断。": "暂时无法连接 AI 服务，请检查服务连接或稍后重试。",
        "AI 服务当前不可用，本次生成已中断。": "AI 服务当前不可用，请检查 AI 配置。",
        "AI 返回内容无法识别，本次生成未产生结果。": "模型返回的格式无法识别，请核对模型和接口配置。",
        "本次生成步骤过多，已中断。": "这次处理步骤达到上限，可缩小范围或继续提问。",
        "本次生成超出时限，已中断。": "这次处理已超时。后台整理可通过任务卡查看进度。",
        "本次生成已停止或超出时限。": "这次处理已停止或超时，请刷新对话核对状态。",
        "配置已变化，请核对后重新发起生成。": "AI 配置已变化，请刷新对话后重新发送。"
    ]
}

struct AssistantClarification: Codable, Equatable, Identifiable {
    struct Option: Codable, Equatable, Identifiable {
        let id: String
        let label: String
    }
    let id: String
    let selection: String
    let question: String
    let options: [Option]
    let allowFreeText: Bool

    var isValid: Bool {
        selection == "single" && !id.isEmpty && !question.isEmpty && question.utf16.count <= 200 &&
        (2...6).contains(options.count) && Set(options.map(\.id)).count == options.count &&
        options.allSatisfy { !$0.id.isEmpty && !$0.label.isEmpty && $0.label.utf16.count <= 100 }
    }
}

struct AssistantProgress: Codable, Equatable { let state: String; let toolName: String? }

struct AssistantMessageContent: Codable, Equatable {
    var version = 1
    var text: String?
    var generationId: String?
    var clarification: AssistantClarification?
    var progress: AssistantProgress?
    var error: AssistantFault?
    var card: JSONValue?
    var result: JSONValue?
    var attachment: JSONValue?
    var importBatch: JSONValue?
}

struct AssistantMessage: Codable, Identifiable, Equatable {
    let id: String
    let conversationId: String
    let role: String
    let kind: String
    let content: AssistantMessageContent
    let createdAt: Int64

    var isVisible: Bool {
        if kind == "progress", content.progress?.state == "complete", (content.text ?? "").isEmpty { return false }
        return !(content.text ?? "").isEmpty || content.error != nil || content.card != nil ||
            content.result != nil || content.clarification != nil || content.attachment != nil ||
            content.importBatch != nil || content.progress?.state == "running" || content.progress?.state == "failed"
    }
}

enum AssistantGenerationStatus: String, Codable {
    case accepted, running, completed, failed, cancelled, interrupted
    var isTerminal: Bool { self != .accepted && self != .running }
}

enum AssistantDelivery: String, Codable { case stream, buffered }
enum AssistantOutcome: String, Codable { case answer; case awaitingChoice = "awaiting-choice"; case pendingConfirmation = "pending-confirmation" }

struct AssistantPartial: Codable, Equatable {
    let messageId: String
    let step: Int
    var text: String
    var validated: Bool
}

struct AssistantGenerationSnapshot: Decodable {
    let version: Int
    let id: String
    let conversationId: String
    let userMessageId: String
    let userMessage: AssistantMessage?
    let status: AssistantGenerationStatus
    let delivery: AssistantDelivery
    let lastSeq: Int64
    let createdAt: Int64
    let updatedAt: Int64
    let partialMessages: [AssistantPartial]
    let messageIds: [String]
    let messages: [AssistantMessage]
    let outcome: AssistantOutcome?
    let error: AssistantFault?

    func validate(conversation: String, generation: String? = nil) throws {
        guard version == 1, !id.isEmpty, conversationId == conversation,
              generation == nil || generation == id, lastSeq >= 0,
              outcome == nil || status == .completed,
              partialMessages.count <= 2_048, messages.count <= 2_048,
              Set(partialMessages.map(\.messageId)).count == partialMessages.count,
              messages.allSatisfy({ !$0.id.isEmpty && $0.conversationId == conversation }),
              userMessage == nil || userMessage?.conversationId == conversation,
              userMessage == nil || userMessage?.id == userMessageId,
              partialMessages.allSatisfy({ !$0.messageId.isEmpty && $0.step >= 0 && $0.text.utf16.count <= 24_000 })
        else { throw AssistantProtocolError.invalidSnapshot }
    }
}

struct AssistantGenerationResponse: Decodable { let generation: AssistantGenerationSnapshot }

enum AssistantProtocolError: LocalizedError, Equatable {
    case invalidSnapshot, invalidEvent, sequenceGap, textOffset, oversizedStream, invalidUTF8, prematureEnd
    var errorDescription: String? { "回复连接需要重新核对，请继续接收或刷新对话。" }
}

struct AssistantStreamEvent: Decodable {
    let version: Int
    let generationId: String
    let seq: Int64
    let type: String
    let status: AssistantGenerationStatus?
    let messageId: String?
    let step: Int?
    let offset: Int?
    let text: String?
    let message: AssistantMessage?
    let outcome: AssistantOutcome?
    let messageIds: [String]?
    let error: AssistantFault?
}

/// One reducer owns the durable cursor, partial text and final-message identity.
struct AssistantGenerationState {
    let id: String
    let conversationId: String
    let createdAt: Int64
    var userMessage: AssistantMessage?
    var status: AssistantGenerationStatus
    var delivery: AssistantDelivery
    var lastSeq: Int64
    var partials: [AssistantPartial]
    var messages: [AssistantMessage]
    var outcome: AssistantOutcome?
    var error: AssistantFault?

    init(_ snapshot: AssistantGenerationSnapshot, conversation: String) throws {
        try snapshot.validate(conversation: conversation)
        id = snapshot.id
        conversationId = snapshot.conversationId
        createdAt = snapshot.createdAt
        userMessage = snapshot.userMessage
        status = snapshot.status
        delivery = snapshot.delivery
        lastSeq = snapshot.lastSeq
        partials = snapshot.partialMessages
        messages = snapshot.messages
        outcome = snapshot.outcome
        error = snapshot.error
    }

    @discardableResult
    mutating func reconcile(_ snapshot: AssistantGenerationSnapshot) throws -> Bool {
        try snapshot.validate(conversation: conversationId, generation: id)
        guard snapshot.lastSeq >= lastSeq else { return false }
        // A cancelled/completed state must not regress to a live snapshot at the same cursor.
        guard !status.isTerminal || snapshot.status.isTerminal else { return false }
        self = try AssistantGenerationState(snapshot, conversation: conversationId)
        return true
    }

    @discardableResult
    mutating func apply(_ event: AssistantStreamEvent) throws -> Bool {
        guard event.version == 1, event.generationId == id, event.seq > 0 else { throw AssistantProtocolError.invalidEvent }
        if event.seq <= lastSeq { return false }
        guard event.seq == lastSeq + 1 else { throw AssistantProtocolError.sequenceGap }
        guard !status.isTerminal else { throw AssistantProtocolError.invalidEvent }
        switch event.type {
        case "state":
            guard let value = event.status, !value.isTerminal else { throw AssistantProtocolError.invalidEvent }
            status = value
        case "text-delta":
            guard let messageID = event.messageId, !messageID.isEmpty,
                  let step = event.step, step >= 0, let offset = event.offset, offset >= 0,
                  let text = event.text, !messages.contains(where: { $0.id == messageID })
            else { throw AssistantProtocolError.invalidEvent }
            let index = partials.firstIndex { $0.messageId == messageID }
            let previous = index.map { partials[$0].text } ?? ""
            guard previous.utf16.count == offset else { throw AssistantProtocolError.textOffset }
            guard previous.utf16.count + text.utf16.count <= 24_000 else { throw AssistantProtocolError.oversizedStream }
            if let index {
                guard partials[index].step == step, !partials[index].validated else { throw AssistantProtocolError.invalidEvent }
                partials[index].text += text
            } else {
                partials.append(AssistantPartial(messageId: messageID, step: step, text: text, validated: false))
            }
        case "message":
            guard let message = event.message, !message.id.isEmpty, message.conversationId == conversationId else { throw AssistantProtocolError.invalidEvent }
            if let index = messages.firstIndex(where: { $0.id == message.id }) { messages[index] = message }
            else { messages.append(message) }
            partials.removeAll { $0.messageId == message.id }
        case "terminal":
            guard let value = event.status, value.isTerminal,
                  event.outcome == nil || value == .completed,
                  event.messageIds != nil else { throw AssistantProtocolError.invalidEvent }
            status = value
            outcome = event.outcome
            error = event.error
        default: throw AssistantProtocolError.invalidEvent
        }
        lastSeq = event.seq
        return true
    }

    /// A history reload is authoritative for a card already confirmed on another client.
    func merged(with history: [AssistantMessage]) -> [AssistantMessage] {
        var output = history
        var ids = Set(history.map(\.id))
        let additional = (userMessage.map { [$0] } ?? []) + messages
        for message in additional where !ids.contains(message.id) {
            ids.insert(message.id)
            output.append(message)
        }
        for partial in partials.sorted(by: { $0.step < $1.step }) where !ids.contains(partial.messageId) && !partial.text.isEmpty {
            ids.insert(partial.messageId)
            output.append(AssistantMessage(id: partial.messageId, conversationId: conversationId, role: "assistant", kind: "text",
                content: AssistantMessageContent(text: partial.text, generationId: id), createdAt: createdAt + Int64(partial.step)))
        }
        return output.enumerated().sorted {
            $0.element.createdAt == $1.element.createdAt ? $0.offset < $1.offset : $0.element.createdAt < $1.element.createdAt
        }.map(\.element).filter(\.isVisible)
    }
}

enum AssistantPath {
    static func segment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))) ?? ""
    }
    static func conversation(_ id: String) -> String { "/assistant/conversations/\(segment(id))" }
}
