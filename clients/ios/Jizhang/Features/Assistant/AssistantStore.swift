import Foundation
import Combine

struct AssistantSubmission: Equatable {
    let requestID: String
    let input: JSONValue
    let draftText: String?
    var pathSuffix: String = "/generations"
    var explicitBody: JSONValue? = nil
    var body: JSONValue { explicitBody ?? .object(["version": .integer(1), "clientRequestId": .string(requestID),
        "input": input, "clientCapabilities": .array([.string("workspace-v1")])]) }
}

struct AssistantThread {
    var history: [AssistantMessage] = []
    var generation: AssistantGenerationState?
    var draft = ""
    var draftRequestID = UUID().uuidString
    var pendingSubmission: AssistantSubmission?
    var sending = false
    var stopping = false
    var loading = false
    var loaded = false
    var reconnectNeeded = false
    var notice: String?
    var readTicket = UUID()
    var actingID: String?
    var uncertainActionID: String?
    var uncertainActionConfirm: Bool?
    var actionNotice: String?
    var pendingFileSubmission: AssistantFileSubmission?
    var workflow: JSONValue?

    var messages: [AssistantMessage] { generation?.merged(with: history) ?? history.filter(\.isVisible) }
    var isGenerating: Bool { generation.map { !$0.status.isTerminal } ?? false }
    var composerLocked: Bool { loading || sending || stopping || isGenerating || pendingSubmission != nil || pendingFileSubmission != nil || actingID != nil }
    var statusLabel: String? {
        if sending { return "正在发送" }
        if stopping { return "正在停止" }
        if reconnectNeeded { return "连接已中断" }
        guard let generation else { return nil }
        switch generation.status {
        case .accepted: return "正在连接 AI"
        case .running: return generation.delivery == .stream ? "正在回复" : "正在准备完整回复"
        case .completed:
            if workflow?["phase"].stringValue == "awaiting-selection" { return "等待你的选择" }
            if workflow?["phase"].stringValue == "awaiting-confirmation" { return "等待确认修改" }
            switch generation.outcome {
            case .awaitingChoice: return "等待你的选择"
            case .pendingConfirmation: return messages.contains { $0.content.card?["status"].stringValue == "pending" } ? "草案已生成，尚未执行" : nil
            default: return nil
            }
        case .cancelled: return "已停止回复"
        case .interrupted: return "回复已中断"
        case .failed: return "回复未完成"
        }
    }
}

@MainActor
final class AssistantStore: ObservableObject {
    let api: APIClient
    @Published private(set) var conversations: [AssistantConversation] = []
    @Published private(set) var threads: [String: AssistantThread] = [:]
    @Published private(set) var selectedID: String?
    @Published private(set) var loadingList = false
    @Published private(set) var creating = false
    @Published private(set) var archivingID: String?
    @Published private(set) var listError: String?
    @Published private(set) var providerEnabled: Bool?
    @Published private(set) var confirmationBodies: [String: JSONValue] = [:]
    @Published private(set) var workspaceCapabilities: JSONValue?
    @Published private(set) var workspaceError: String?
    @Published private(set) var workspaceBusy = Set<String>()
    @Published private(set) var workspacePendingBodies: [String: JSONValue] = [:]
    @Published private(set) var nativeCompletionNotices: [String: String] = [:]
    @Published private(set) var nativeCompletionRetries: [String: NativeWorkspaceCompletion] = [:]
    private var billFiles: [String: AssistantBillFile] = [:]
    private var listTicket = UUID()
    private var selectionTicket = UUID()
    private var visibleConversationID: String?
    private var streamTask: Task<Void, Never>?
    private var dailyLaunchJobs: [String: Task<AssistantConversation?, Never>] = [:]
    private var dailyLaunchTail: Task<AssistantConversation?, Never>?
    private var dailyLaunchTailID: String?
    private var conversationCreationWaiters: [CheckedContinuation<Void, Never>] = []
    private var dailyAccepted: [String: (AssistantGenerationSnapshot) -> Bool] = [:]
    private var dailyUncertain: [String: () -> Void] = [:]
    private var dailyWillSubmit: [String: () -> Bool] = [:]
    private var completedNativeRequests = Set<String>()

    init(api: APIClient) { self.api = api }
    deinit { streamTask?.cancel() }

    func thread(_ id: String) -> AssistantThread { threads[id] ?? AssistantThread() }

    private func update(_ id: String, _ change: (inout AssistantThread) -> Void) {
        var value = threads[id] ?? AssistantThread()
        change(&value)
        threads[id] = value
    }

    func loadConversations() async {
        let ticket = UUID()
        listTicket = ticket
        loadingList = true
        listError = nil
        defer { if listTicket == ticket { loadingList = false } }
        do {
            let response: AssistantItems<AssistantConversation> = try await api.request("/assistant/conversations")
            try Task.checkCancellation()
            guard listTicket == ticket else { return }
            guard response.items.allSatisfy({ !$0.id.isEmpty }), Set(response.items.map(\.id)).count == response.items.count else {
                throw AssistantProtocolError.invalidSnapshot
            }
            conversations = response.items.filter { !$0.archived }.sorted { $0.updatedAt > $1.updatedAt }
        } catch {
            guard !Task.isCancelled, listTicket == ticket else { return }
            listError = error.localizedDescription
        }
    }

    func loadProviderStatus() async {
        do {
            let response: ProviderConfiguration = try await api.request("/ai/config")
            try Task.checkCancellation()
            providerEnabled = response.configured && response.enabled
        } catch { if !Task.isCancelled { providerEnabled = nil } }
    }

    func createConversation() async -> AssistantConversation? {
        guard !creating, archivingID == nil else { return nil }
        creating = true
        listError = nil
        listTicket = UUID()
        loadingList = false
        defer {
            creating = false
            let waiters = conversationCreationWaiters
            conversationCreationWaiters.removeAll()
            for waiter in waiters { waiter.resume() }
        }
        do {
            let conversation: AssistantConversation = try await api.request("/assistant/conversations", method: "POST")
            guard !conversation.id.isEmpty, !conversation.archived else { throw AssistantProtocolError.invalidSnapshot }
            listTicket = UUID()
            loadingList = false
            conversations.removeAll { $0.id == conversation.id }
            conversations.insert(conversation, at: 0)
            threads[conversation.id] = AssistantThread()
            return conversation
        } catch { listError = error.localizedDescription; return nil }
    }

    func archive(_ conversation: AssistantConversation) async {
        guard archivingID == nil, !thread(conversation.id).sending, thread(conversation.id).actingID == nil else { return }
        archivingID = conversation.id
        listError = nil
        listTicket = UUID()
        loadingList = false
        defer { archivingID = nil }
        do {
            let result: JSONValue = try await api.request(AssistantPath.conversation(conversation.id), method: "DELETE")
            guard result["ok"].boolValue == true else { throw AssistantProtocolError.invalidSnapshot }
            listTicket = UUID()
            loadingList = false
            if selectedID == conversation.id { leave(conversation.id); selectedID = nil }
            conversations.removeAll { $0.id == conversation.id }
            threads.removeValue(forKey: conversation.id)
        } catch { listError = error.localizedDescription }
    }

    func setDraft(_ text: String, for id: String) {
        guard !thread(id).composerLocked else { return }
        update(id) {
            if $0.draft != text { $0.draft = text; $0.draftRequestID = UUID().uuidString }
        }
    }

    func open(_ id: String) async {
        streamTask?.cancel()
        streamTask = nil
        selectedID = id
        visibleConversationID = id
        let selection = UUID()
        selectionTicket = selection
        let read = UUID()
        update(id) {
            $0.loading = true
            if $0.pendingSubmission == nil && $0.pendingFileSubmission == nil { $0.notice = nil }
            $0.readTicket = read; $0.reconnectNeeded = false
        }
        defer {
            if accepts(id, selection), threads[id]?.readTicket == read { update(id) { $0.loading = false } }
        }
        do {
            let history: AssistantItems<AssistantMessage> = try await api.request(AssistantPath.conversation(id) + "/messages")
            try Task.checkCancellation()
            guard accepts(id, selection), threads[id]?.readTicket == read else { return }
            try validateHistory(history.items, conversation: id)
            applyHistory(history.items, in: id)
            let latest: AssistantItems<AssistantGenerationSnapshot> = try await api.request(AssistantPath.conversation(id) + "/generations?limit=1")
            try Task.checkCancellation()
            guard accepts(id, selection), threads[id]?.readTicket == read else { return }
            guard latest.items.count <= 1 else { throw AssistantProtocolError.invalidSnapshot }
            if let snapshot = latest.items.first { try install(snapshot, conversation: id) }
            update(id) { $0.loading = false }
            if thread(id).isGenerating { listen(id, selection: selection) }
            await refreshWorkspaceState(in: id)
        } catch {
            guard !Task.isCancelled, accepts(id, selection), threads[id]?.readTicket == read else { return }
            update(id) { $0.notice = error.localizedDescription; $0.reconnectNeeded = $0.isGenerating }
        }
    }

    func leave(_ id: String) {
        guard visibleConversationID == id else { return }
        visibleConversationID = nil
        selectionTicket = UUID()
        update(id) { $0.loading = false; $0.readTicket = UUID() }
        streamTask?.cancel()
        streamTask = nil
    }

    func sendText(in id: String) async {
        let current = thread(id)
        let text = current.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !current.composerLocked, !text.isEmpty else { return }
        guard text.utf16.count <= 2_000 else { update(id) { $0.notice = "每条消息最多 2,000 字，请分段发送。" }; return }
        let input: JSONValue = .object(["type": .string("text"), "text": .string(text)])
        await submit(AssistantSubmission(requestID: current.draftRequestID, input: input, draftText: current.draft), in: id)
    }

    func canAnswer(_ message: AssistantMessage, in id: String) -> Bool {
        let current = thread(id)
        guard !current.composerLocked, let generation = current.generation,
              generation.status == .completed, generation.outcome == .awaitingChoice,
              message.content.generationId == generation.id,
              message.content.clarification?.isValid == true else { return false }
        return true
    }

    func answer(_ option: AssistantClarification.Option, message: AssistantMessage, in id: String) async {
        guard canAnswer(message, in: id), let question = message.content.clarification,
              let generationID = message.content.generationId else { return }
        let input: JSONValue = .object(["type": .string("choice"), "sourceGenerationId": .string(generationID),
            "questionId": .string(question.id), "optionId": .string(option.id)])
        await submit(AssistantSubmission(requestID: UUID().uuidString, input: input, draftText: nil), in: id)
    }

    func retrySubmission(in id: String) async {
        guard let submission = thread(id).pendingSubmission, !thread(id).sending, !thread(id).isGenerating else { return }
        await submit(submission, in: id)
    }

    private func submit(_ submission: AssistantSubmission, in id: String,
                        onAccepted: ((AssistantGenerationSnapshot) -> Bool)? = nil,
                        onUncertain: (() -> Void)? = nil) async {
        guard !thread(id).sending else { return }
        if let willSubmit = dailyWillSubmit[submission.requestID], !willSubmit() { return }
        let acceptedObserver = onAccepted ?? dailyAccepted[submission.requestID]
        let uncertainObserver = onUncertain ?? dailyUncertain[submission.requestID]
        if visibleConversationID == id {
            streamTask?.cancel()
            streamTask = nil
            selectionTicket = UUID()
        }
        update(id) {
            $0.readTicket = UUID(); $0.loading = false; $0.sending = true
            $0.pendingSubmission = submission; $0.notice = nil; $0.reconnectNeeded = false
        }
        defer {
            if threads[id]?.pendingSubmission?.requestID == submission.requestID || threads[id]?.pendingSubmission == nil {
                update(id) { $0.sending = false }
            }
        }
        do {
            let response: AssistantGenerationResponse = try await api.request(AssistantPath.conversation(id) + submission.pathSuffix, method: "POST", body: submission.body)
            guard threads[id]?.pendingSubmission?.requestID == submission.requestID else { return }
            try response.generation.validate(conversation: id)
            if let acceptedObserver, !acceptedObserver(response.generation) {
                update(id) { $0.notice = "回复已生成，但本机任务状态尚未保存。请刷新核对或重试同一个请求。" }
                return
            }
            dailyAccepted.removeValue(forKey: submission.requestID)
            dailyUncertain.removeValue(forKey: submission.requestID)
            dailyWillSubmit.removeValue(forKey: submission.requestID)
            try install(response.generation, conversation: id)
            update(id) {
                $0.pendingSubmission = nil
                $0.sending = false
                $0.readTicket = UUID()
                $0.loading = false
                if let text = submission.draftText, $0.draft == text {
                    $0.draft = ""; $0.draftRequestID = UUID().uuidString
                }
            }
            // Responses are cached only in their owning thread; selecting another chat never
            // installs this result into that chat or starts an unwanted subscription there.
            // The user may have left and reopened this thread while POST was pending.
            // Continue with its current visible selection, never the submitting screen's token.
            if visibleConversationID == id {
                let selection = selectionTicket
                if thread(id).isGenerating { listen(id, selection: selection) }
                await refreshHistory(id, selection: selection)
            }
        } catch {
            guard threads[id]?.pendingSubmission?.requestID == submission.requestID else { return }
            if let apiError = error as? APIError, (400..<500).contains(apiError.status), apiError.status != 408 {
                // A rejected choice/request did not create a turn. Keeping it as an uncertain
                // submission would lock the composer into retrying the same stale choice forever.
                update(id) { $0.pendingSubmission = nil; $0.sending = false }
                if visibleConversationID == id, apiError.status == 409 {
                    await open(id)
                }
                update(id) { $0.notice = apiError.localizedDescription }
            } else {
                uncertainObserver?()
                update(id) { $0.notice = "发送结果待核对。\(error.localizedDescription) 重试会使用同一个请求编号，避免重复提问。" }
            }
        }
    }

    /// Notification intent has already been persisted by the account-owned outbox.
    /// The tap authorizes this one read-only request; ordinary reopen only reconciles.
    func launchDailyReview(_ intent: AssistantLaunchIntent,
                           checkpoint: @escaping (AssistantLaunchIntent, DailyReviewCheckpoint) -> Bool) async -> AssistantConversation? {
        if let current = dailyLaunchJobs[intent.id] { return await current.value }
        let preceding = dailyLaunchTail
        let job = Task<AssistantConversation?, Never> { [weak self] in
            _ = await preceding?.value
            guard let self else { return nil }
            return await self.performDailyReviewLaunch(intent, checkpoint: checkpoint)
        }
        dailyLaunchJobs[intent.id] = job
        dailyLaunchTail = job; dailyLaunchTailID = intent.id
        let result = await job.value
        dailyLaunchJobs.removeValue(forKey: intent.id)
        if dailyLaunchTailID == intent.id { dailyLaunchTail = nil; dailyLaunchTailID = nil }
        return result
    }

    private func performDailyReviewLaunch(_ intent: AssistantLaunchIntent,
                           checkpoint: @escaping (AssistantLaunchIntent, DailyReviewCheckpoint) -> Bool) async -> AssistantConversation? {
        guard intent.apiIdentity == api.identity,
              !intent.clientRequestID.isEmpty, intent.clientRequestID.utf16.count <= 120,
              TimeZone(identifier: intent.timeZone) != nil,
              intent.date.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return nil }
        let conversation: AssistantConversation
        if let id = intent.conversationID {
            conversation = conversations.first(where: { $0.id == id }) ?? AssistantConversation(
                id: id, title: "每日复盘 · \(intent.date)", archived: false, createdAt: 0, updatedAt: 0)
        } else {
            guard intent.mayStart else { return nil }
            // A notification can arrive while the user is creating an unrelated chat.
            // Wait for that actual request to settle, then create a distinct daily chat.
            while creating {
                await withCheckedContinuation { conversationCreationWaiters.append($0) }
                guard !Task.isCancelled else { return nil }
            }
            guard let created = await createConversation() else {
                listError = "每日复盘仍待处理，尚未开始分析。请稍后重试通知，原请求会保留。"
                return nil
            }
            conversation = created
        }
        guard checkpoint(intent, .conversation(conversation.id)), intent.apiIdentity == api.identity else {
            listError = "每日复盘的状态未能保存，尚未发起分析。请重试通知或检查本机存储。"
            return nil
        }
        let ready = await reconcileDailyConversation(conversation.id)
        guard !Task.isCancelled else { return nil }
        if ready, let known = thread(conversation.id).generation {
            _ = checkpoint(intent, .accepted(known.id))
            return conversation
        }
        let text = "请复盘 \(intent.date)，账本时区为 \(intent.timeZone)。请读取服务端这一天的完整收入、支出、退款、工资、分类与账户汇总，指出需要核对的记录。只读分析，不修改任何账本或设置。"
        let submission = AssistantSubmission(requestID: intent.clientRequestID,
            input: .object(["type": .string("text"), "text": .string(text)]), draftText: nil,
            pathSuffix: "/workspace/daily-review", explicitBody: .object(["clientRequestId": .string(intent.clientRequestID),
                "date": .string(intent.date), "timeZone": .string(intent.timeZone)]))
        dailyAccepted[submission.requestID] = { checkpoint(intent, .accepted($0.id)) }
        dailyUncertain[submission.requestID] = { _ = checkpoint(intent, .uncertain(conversation.id)) }
        dailyWillSubmit[submission.requestID] = { checkpoint(intent, .submitting(conversation.id)) }
        if intent.mayStart && ready {
            await submit(submission, in: conversation.id)
        } else {
            update(conversation.id) {
                if $0.pendingSubmission == nil {
                    $0.pendingSubmission = submission
                    $0.notice = "每日复盘的发送结果尚待核对。可刷新对话，或显式重试同一个请求；不会自动重新调用模型。"
                }
            }
        }
        return conversation
    }

    /// Daily launch work may be queued behind another day or displayed conversation.
    /// Reconcile its own data without calling open(), stealing selection or cancelling SSE.
    private func reconcileDailyConversation(_ id: String) async -> Bool {
        let read = UUID()
        update(id) { $0.readTicket = read }
        do {
            let history: AssistantItems<AssistantMessage> = try await api.request(AssistantPath.conversation(id) + "/messages")
            try validateHistory(history.items, conversation: id)
            let latest: AssistantItems<AssistantGenerationSnapshot> = try await api.request(AssistantPath.conversation(id) + "/generations?limit=1")
            guard !Task.isCancelled, threads[id]?.readTicket == read, latest.items.count <= 1 else { return false }
            applyHistory(history.items, in: id)
            if let snapshot = latest.items.first { try install(snapshot, conversation: id) }
            return true
        } catch {
            if threads[id]?.readTicket == read { update(id) { $0.notice = "每日复盘对话暂时无法核对。原请求已保留，可刷新或显式重试。" } }
            return false
        }
    }

    func stop(in id: String) async {
        guard let generation = thread(id).generation, !generation.status.isTerminal, !thread(id).stopping else { return }
        if visibleConversationID == id {
            streamTask?.cancel()
            streamTask = nil
            selectionTicket = UUID()
        }
        update(id) { $0.stopping = true; $0.loading = false; $0.readTicket = UUID(); $0.notice = nil }
        defer { update(id) { $0.stopping = false } }
        do {
            let response: AssistantGenerationResponse = try await api.request(AssistantPath.conversation(id) + "/generations/\(AssistantPath.segment(generation.id))/cancel", method: "POST")
            try response.generation.validate(conversation: id, generation: generation.id)
            guard threads[id]?.generation?.id == generation.id else { return }
            try install(response.generation, conversation: id)
            update(id) { $0.reconnectNeeded = false; $0.loading = false; $0.readTicket = UUID() }
            if visibleConversationID == id { await refreshHistory(id, selection: selectionTicket) }
        } catch {
            update(id) { $0.notice = "停止结果需要核对，请刷新对话。"; $0.reconnectNeeded = true }
        }
    }

    func reconnect(in id: String) async { await open(id) }

    func loadCapabilities() async {
        do {
            let value: JSONValue = try await api.request("/assistant/workspace/capabilities")
            guard !Task.isCancelled, value["version"].intValue == 1, value["items"].arrayValue != nil else { return }
            workspaceCapabilities = value; workspaceError = nil
        } catch { if !Task.isCancelled { workspaceError = "功能目录暂时无法读取，可重试或直接发送问题。" } }
    }

    func beginCapability(_ item: JSONValue) async -> AssistantConversation? {
        guard let name = item["name"].stringValue,
              workspaceCapabilities?["items"].arrayValue?.contains(where: { $0["name"].stringValue == name }) == true,
              let conversation = await createConversation() else { return nil }
        await open(conversation.id)
        setDraft("请帮我使用「\(AssistantToolPresentation.title(name))」功能（\(name)）。请先读取所需事实，缺少信息时用选择卡询问；涉及修改先给我预览，等待我确认。", for: conversation.id)
        await sendText(in: conversation.id)
        return conversation
    }

    func acceptWorkspaceGeneration(_ snapshot: AssistantGenerationSnapshot, in id: String) {
        do {
            try snapshot.validate(conversation: id)
            try install(snapshot, conversation: id)
            if visibleConversationID == id, thread(id).isGenerating { listen(id, selection: selectionTicket) }
            Task { await refreshWorkspaceState(in: id) }
        } catch { update(id) { $0.actionNotice = "任务状态需要重新核对，请刷新对话。" } }
    }

    private func refreshWorkspaceState(in id: String) async {
        guard workspaceCapabilities != nil else { return }
        let generation = thread(id).generation?.id
        do {
            let response: JSONValue = try await api.request(AssistantWorkspacePath.base(id))
            guard !Task.isCancelled, thread(id).generation?.id == generation else { return }
            if response["workflow"] == .null { update(id) { $0.workflow = nil } }
            else if response["workflow"]["version"].intValue == 1, response["workflow"]["id"].stringValue != nil {
                update(id) { $0.workflow = response["workflow"] }
            }
        } catch { /* Workflow diagnostics cannot displace durable messages. */ }
    }

    func reviseDraft(_ card: JSONValue, in id: String, arguments: JSONValue) async -> Bool {
        guard let actionID = card["actionId"].stringValue, canAct(on: card, in: id) else { return false }
        let key = "revise:" + actionID
        return await workspaceMutation(key: key, in: id, path: "/actions/" + AssistantPath.segment(actionID) + "/revise",
            fields: ["arguments": arguments])
    }

    func prepareOrganization(in id: String, messageID: String, runID: String?, selected: Set<String>, onPrepared: (() -> Void)? = nil) async -> Bool {
        guard visibleConversationID == id, !thread(id).composerLocked, !selected.isEmpty, selected.count <= 100 else { return false }
        let key = "organization:" + messageID
        var fields: [String: JSONValue] = ["kind": .string(runID == nil ? "structural" : "spending"),
            "actionIds": .array(selected.sorted().map(JSONValue.string))]
        if let runID { fields["runId"] = .string(runID) } else { fields["previewMessageId"] = .string(messageID) }
        let prepared = await workspaceMutation(key: key, in: id, path: "/organization/prepare", fields: fields)
        if prepared { onPrepared?() }
        return prepared
    }

    private func workspaceMutation(key: String, in id: String, path: String, fields: [String: JSONValue]) async -> Bool {
        guard !workspaceBusy.contains(key), visibleConversationID == id else { return false }
        var fields = fields; fields["clientRequestId"] = .string(UUID().uuidString)
        let body = workspacePendingBodies[key] ?? .object(fields)
        workspacePendingBodies[key] = body; workspaceBusy.insert(key)
        defer { workspaceBusy.remove(key) }
        do {
            let response: AssistantWorkspaceMutationResponse = try await api.request(AssistantWorkspacePath.base(id) + path, method: "POST", body: body)
            guard response.action.conversationId == id, response.action.status == "pending", !response.action.id.isEmpty else { throw AssistantProtocolError.invalidSnapshot }
            try validateHistory(response.messages, conversation: id)
            guard response.messages.contains(where: { $0.content.card?["actionId"].stringValue == response.action.id && $0.content.card?["status"].stringValue == "pending" }) else { throw AssistantProtocolError.invalidSnapshot }
            applyHistory(response.messages, in: id)
            await refreshWorkspaceState(in: id)
            workspacePendingBodies.removeValue(forKey: key)
            update(id) { $0.actionNotice = "新草案已准备好。请核对修改内容，再确认执行。" }
            return true
        } catch {
            if let failure = error as? APIError, (400..<500).contains(failure.status), failure.status != 408 { workspacePendingBodies.removeValue(forKey: key) }
            update(id) { $0.actionNotice = workspacePendingBodies[key] == nil ? error.localizedDescription : "草案结果待核对。再次操作会重试相同请求；请先刷新查看已有内容。" }
            return false
        }
    }

    func continueConfirmed(_ card: JSONValue, in id: String) async {
        guard workspaceCapabilities != nil, visibleConversationID == id, !thread(id).composerLocked,
              let actionID = card["actionId"].stringValue else { return }
        let key = "continue:" + actionID
        guard !workspaceBusy.contains(key) else { return }
        let body = workspacePendingBodies[key] ?? .object(["clientRequestId": .string("continue-" + actionID)])
        workspacePendingBodies[key] = body; workspaceBusy.insert(key)
        defer { workspaceBusy.remove(key) }
        do {
            let response: AssistantWorkspaceGenerationResponse = try await api.request(AssistantWorkspacePath.base(id) + "/actions/" + AssistantPath.segment(actionID) + "/continue", method: "POST", body: body)
            workspacePendingBodies.removeValue(forKey: key)
            acceptWorkspaceGeneration(response.generation, in: id)
        } catch {
            if let failure = error as? APIError, failure.status == 404 { workspacePendingBodies.removeValue(forKey: key); return }
            update(id) { $0.actionNotice = "账本操作已确认，后续回复尚待核对。可点「继续原任务」重试同一个续接请求。" }
        }
    }

    static func nativeSourceKey(conversationID: String, messageID: String) -> String { conversationID + ":" + messageID }

    /// Only a trusted, dismissed native workspace emits this receipt. The backend checks
    /// its actual result again; receipt delivery is never a new financial authorization.
    func continueNativeCompletion(_ completion: NativeWorkspaceCompletion) async {
        guard completion.apiIdentity == api.identity, !completion.conversationID.isEmpty,
              !completion.sourceMessageID.isEmpty, !completion.clientRequestID.isEmpty,
              completion.clientRequestID.utf16.count <= 120,
              let reference = completion.reference.objectValue,
              Set(reference.keys).isSubset(of: ["kind", "previewId", "batchId", "itemId", "operation", "sha256", "exportKind"]),
              reference.values.allSatisfy({ $0.stringValue != nil && ($0.stringValue?.utf8.count ?? 201) <= 200 }),
              ["csv-import", "platform-import", "item-photo", "export"].contains(completion.reference["kind"].stringValue ?? "") else { return }
        let key = "native:" + completion.clientRequestID
        let sourceKey = Self.nativeSourceKey(conversationID: completion.conversationID, messageID: completion.sourceMessageID)
        guard !workspaceBusy.contains(key), !completedNativeRequests.contains(completion.clientRequestID) else { return }
        workspaceBusy.insert(key)
        defer { workspaceBusy.remove(key) }
        nativeCompletionRetries[key] = completion
        let body = workspacePendingBodies[key] ?? completion.body
        workspacePendingBodies[key] = body
        do {
            if !thread(completion.conversationID).messages.contains(where: { $0.id == completion.sourceMessageID }) {
                let history: AssistantItems<AssistantMessage> = try await api.request(AssistantPath.conversation(completion.conversationID) + "/messages")
                try validateHistory(history.items, conversation: completion.conversationID)
                guard !Task.isCancelled else { return }
                applyHistory(history.items, in: completion.conversationID)
            }
            guard let source = thread(completion.conversationID).messages.first(where: { $0.id == completion.sourceMessageID }),
                  source.content.result?["toolName"].stringValue == "workspace.open",
                  let destination = source.content.result?["data"]["nativeAction"]["destination"].stringValue else { throw AssistantProtocolError.invalidSnapshot }
            let matching: [String: Set<String>] = ["csv-import": ["data-import"], "platform-import": ["platform-import"],
                "item-photo": ["item-photo", "item-cutout"], "export": ["data-export"]]
            guard matching[completion.reference["kind"].stringValue ?? ""]?.contains(destination) == true else { throw AssistantProtocolError.invalidSnapshot }
            if completion.reference["kind"].stringValue == "item-photo" {
                guard source.content.result?["data"]["nativeAction"]["itemId"].stringValue == completion.reference["itemId"].stringValue else { throw AssistantProtocolError.invalidSnapshot }
            }
            let response: AssistantWorkspaceGenerationResponse = try await api.request(AssistantWorkspacePath.base(completion.conversationID) + "/native-completions", method: "POST", body: body)
            try response.generation.validate(conversation: completion.conversationID)
            guard !Task.isCancelled else { return }
            completedNativeRequests.insert(completion.clientRequestID)
            workspacePendingBodies.removeValue(forKey: key); nativeCompletionRetries.removeValue(forKey: key)
            nativeCompletionNotices[sourceKey] = "功能结果已重新核实，原任务正在继续。"
            acceptWorkspaceGeneration(response.generation, in: completion.conversationID)
        } catch {
            nativeCompletionNotices[sourceKey] = "功能结果的续接尚待核对。可重试同一回执，无需重复导入、修改照片或下载文件。"
            update(completion.conversationID) { $0.actionNotice = "原功能操作请以工作区结果为准；后续回复尚待核对，可在原功能卡继续原任务。" }
        }
    }

    func retryNativeCompletion(conversationID: String, messageID: String) async {
        guard let completion = nativeCompletionRetries.values.first(where: { $0.conversationID == conversationID && $0.sourceMessageID == messageID }) else { return }
        await continueNativeCompletion(completion)
    }

    func hasPendingNativeCompletion(conversationID: String, messageID: String) -> Bool {
        nativeCompletionRetries.values.contains { $0.conversationID == conversationID && $0.sourceMessageID == messageID }
    }

    func canAct(on card: JSONValue, in id: String, confirm: Bool = true) -> Bool {
        let state = thread(id)
        guard visibleConversationID == id, !state.composerLocked, state.loaded,
              let actionID = card["actionId"].stringValue, !actionID.isEmpty,
              card["version"].intValue == 1, card["writes"].boolValue == true,
              card["status"].stringValue == "pending",
              !((card["fingerprint"].stringValue ?? "").isEmpty),
              state.messages.contains(where: { $0.content.card == card }) else { return false }
        return state.uncertainActionID == nil || (state.uncertainActionID == actionID && state.uncertainActionConfirm == confirm)
    }

    /// The persisted action ID is the server's idempotency identity, including after a lost response.
    func performAction(_ card: JSONValue, in id: String, confirm: Bool, body: JSONValue = .object([:])) async {
        guard canAct(on: card, in: id, confirm: confirm), let actionID = card["actionId"].stringValue else { return }
        let body = confirm ? (confirmationBodies[actionID] ?? body) : body
        if confirm { confirmationBodies[actionID] = body }
        update(id) { $0.actingID = actionID; $0.actionNotice = nil; $0.readTicket = UUID() }
        defer { if threads[id]?.actingID == actionID { update(id) { $0.actingID = nil } } }
        do {
            let response: AssistantActionResponse = try await api.request(
                "/assistant/actions/\(AssistantPath.segment(actionID))/\(confirm ? "confirm" : "cancel")",
                method: "POST", body: body)
            try response.validate(actionID: actionID, conversationID: id, confirming: confirm)
            guard threads[id]?.actingID == actionID else { return }
            update(id) {
                $0.readTicket = UUID()
                $0.history = AssistantActionResponse.updating($0.messages, actionID: actionID, status: response.action.status)
                $0.uncertainActionID = nil
                $0.uncertainActionConfirm = nil
                $0.actingID = nil
                $0.actionNotice = response.action.status == "confirmed" ? "已执行，账本已更新。" : "已取消，账本没有改动。"
            }
            if response.action.status == "confirmed" { api.notifyLedgerChanged() }
            if visibleConversationID == id { await refreshHistory(id, selection: selectionTicket) }
            if response.action.status == "confirmed" { await continueConfirmed(card, in: id) }
        } catch {
            guard threads[id]?.actingID == actionID else { return }
            if let apiError = error as? APIError, (400..<500).contains(apiError.status), apiError.status != 408 {
                confirmationBodies.removeValue(forKey: actionID)
                update(id) {
                    $0.uncertainActionID = nil
                    $0.uncertainActionConfirm = nil
                    $0.actionNotice = apiError.localizedDescription
                }
            } else {
                update(id) {
                    $0.uncertainActionID = actionID
                    $0.uncertainActionConfirm = confirm
                    $0.actionNotice = confirm ? "暂未核实操作结果。请刷新查看；如仍待确认，可重试同一草案，不会重复记账。" : "取消结果待核对。请刷新查看，或重试取消这份草案。"
                }
            }
            if visibleConversationID == id { await refreshHistory(id, selection: selectionTicket) }
        }
    }

    func useSuggestion(_ text: String, in id: String) {
        guard !thread(id).composerLocked else { return }
        setDraft(text, for: id)
    }

    func cachedFile(for card: JSONValue) -> AssistantBillFile? {
        card["attachment"]["sha256"].stringValue.flatMap { billFiles[$0] }
    }

    func retainFile(_ file: AssistantBillFile, for card: JSONValue) throws {
        guard file.matches(card["attachment"]) else { throw AssistantFileError.differentFile }
        billFiles[file.digest] = file
    }

    func sendFile(_ file: AssistantBillFile, in id: String) async {
        guard !thread(id).composerLocked else { return }
        billFiles[file.digest] = file
        let text = thread(id).draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.utf16.count <= 2_000 else { update(id) { $0.notice = "消息不能超过 2,000 个字符。" }; return }
        let submission = AssistantFileSubmission(file: file, text: text.isEmpty ? "请预览这份账单，等我选择并确认后再导入。" : text)
        update(id) { $0.pendingFileSubmission = submission }
        await retryFile(in: id)
    }

    func retryFile(in id: String) async {
        guard let submission = thread(id).pendingFileSubmission, !thread(id).sending, !thread(id).isGenerating else { return }
        update(id) { $0.sending = true; $0.notice = nil; $0.readTicket = UUID() }
        defer { if threads[id] != nil { update(id) { $0.sending = false } } }
        do {
            let response: AssistantItems<AssistantMessage> = try await api.request(AssistantPath.conversation(id) + "/messages", method: "POST", body: submission.body)
            try validateHistory(response.items, conversation: id)
            guard threads[id]?.pendingFileSubmission?.requestID == submission.requestID else { return }
            update(id) {
                $0.readTicket = UUID(); $0.history = response.items; $0.loaded = true; $0.generation = nil
                $0.pendingFileSubmission = nil; $0.draft = ""; $0.draftRequestID = UUID().uuidString
                if response.items.last?.content.progress?.state == "running" || response.items.last?.kind == "attachment" {
                    $0.notice = "文件已接收，预览可能仍在处理中。稍后刷新对话查看结果。"
                }
            }
        } catch {
            guard threads[id]?.pendingFileSubmission?.requestID == submission.requestID else { return }
            if let apiError = error as? APIError, (400..<500).contains(apiError.status), apiError.status != 408 {
                update(id) { $0.pendingFileSubmission = nil; $0.notice = apiError.localizedDescription }
            } else {
                update(id) { $0.notice = "账单文件的预览状态尚未核实。可重试同一次上传，文件不会自动导入。" }
            }
        }
    }

    private func accepts(_ id: String, _ selection: UUID) -> Bool {
        visibleConversationID == id && selectedID == id && selectionTicket == selection
    }

    private func install(_ snapshot: AssistantGenerationSnapshot, conversation id: String) throws {
        try snapshot.validate(conversation: id)
        var current = thread(id)
        if var generation = current.generation, generation.id == snapshot.id {
            try generation.reconcile(snapshot)
            current.generation = generation
        } else {
            if let previous = current.generation, snapshot.createdAt < previous.createdAt { return }
            current.generation = try AssistantGenerationState(snapshot, conversation: id)
        }
        threads[id] = current
    }

    private func validateHistory(_ messages: [AssistantMessage], conversation: String) throws {
        guard messages.allSatisfy({ !$0.id.isEmpty && $0.conversationId == conversation }),
              Set(messages.map(\.id)).count == messages.count else { throw AssistantProtocolError.invalidSnapshot }
    }

    private func refreshHistory(_ id: String, selection: UUID) async {
        guard accepts(id, selection) else { return }
        let read = UUID()
        update(id) { $0.readTicket = read }
        do {
            let response: AssistantItems<AssistantMessage> = try await api.request(AssistantPath.conversation(id) + "/messages")
            guard accepts(id, selection), threads[id]?.readTicket == read, !Task.isCancelled else { return }
            try validateHistory(response.items, conversation: id)
            applyHistory(response.items, in: id)
            await refreshWorkspaceState(in: id)
        } catch {
            guard accepts(id, selection), threads[id]?.readTicket == read, !Task.isCancelled else { return }
            update(id) { $0.notice = "回复已保留，历史同步失败，请刷新核对。" }
        }
    }

    private func applyHistory(_ messages: [AssistantMessage], in id: String) {
        let uncertainID = thread(id).uncertainActionID
        let resolved = messages.compactMap(\.content.card).first { uncertainID != nil && $0["actionId"].stringValue == uncertainID && $0["status"].stringValue != "pending" }
        update(id) {
            $0.history = messages; $0.loaded = true
            if let resolved {
                $0.uncertainActionID = nil
                $0.uncertainActionConfirm = nil
                $0.actingID = nil
                $0.actionNotice = resolved["status"].stringValue == "confirmed" ? "已核实：操作已执行，账本已更新。" : "草案已关闭，请查看最新记录。"
            }
        }
        if let resolved, resolved["status"].stringValue == "confirmed" {
            api.notifyLedgerChanged()
            Task { await continueConfirmed(resolved, in: id) }
        }
    }

    private func listen(_ id: String, selection: UUID) {
        guard let generation = thread(id).generation, !generation.status.isTerminal else { return }
        streamTask?.cancel()
        streamTask = Task { [weak self] in
            guard let self else { return }
            do {
                let path = AssistantPath.conversation(id) + "/generations/\(AssistantPath.segment(generation.id))/events?afterSeq=\(generation.lastSeq)"
                let bytes = try await api.stream(path)
                defer { bytes.task.cancel() }
                var parser = AssistantSSEParser()
                var terminal = false
                try await withTaskCancellationHandler {
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        guard self.accepts(id, selection), self.threads[id]?.generation?.id == generation.id else { return }
                        if let frame = try parser.feed(byte) {
                            let event = try frame.decode()
                            var current = self.thread(id)
                            guard var reducer = current.generation else { throw AssistantProtocolError.invalidSnapshot }
                            try reducer.apply(event)
                            current.generation = reducer
                            current.reconnectNeeded = false
                            self.threads[id] = current
                            if reducer.status.isTerminal { terminal = true; break }
                        }
                    }
                } onCancel: { bytes.task.cancel() }
                guard !Task.isCancelled, accepts(id, selection) else { return }
                guard terminal else { throw AssistantProtocolError.prematureEnd }
                await refreshHistory(id, selection: selection)
            } catch {
                guard !Task.isCancelled, accepts(id, selection) else { return }
                await reconcileAfterDisconnect(id, generation: generation.id, selection: selection)
            }
        }
    }

    private func reconcileAfterDisconnect(_ id: String, generation: String, selection: UUID) async {
        do {
            let response: AssistantGenerationResponse = try await api.request(AssistantPath.conversation(id) + "/generations/\(AssistantPath.segment(generation))")
            guard accepts(id, selection), !Task.isCancelled, threads[id]?.generation?.id == generation else { return }
            try response.generation.validate(conversation: id, generation: generation)
            try install(response.generation, conversation: id)
            if thread(id).isGenerating {
                update(id) { $0.reconnectNeeded = true; $0.notice = "连接已断开，回复仍可能在进行。继续接收会核对同一条回复。" }
            } else {
                update(id) { $0.reconnectNeeded = false }
                await refreshHistory(id, selection: selection)
            }
        } catch {
            guard accepts(id, selection), !Task.isCancelled else { return }
            update(id) { $0.reconnectNeeded = true; $0.notice = "暂时无法核对回复状态，请联网后继续接收。" }
        }
    }
}
