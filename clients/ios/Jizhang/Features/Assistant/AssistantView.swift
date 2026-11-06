import SwiftUI
import UniformTypeIdentifiers

struct AssistantConversationGroup: Identifiable {
    let title: String
    let conversations: [AssistantConversation]
    var id: String { title }

    static func make(_ values: [AssistantConversation], query: String, now: Date = Date(), calendar: Calendar = .current) -> [Self] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let filtered = values.filter { query.isEmpty || $0.displayTitle.localizedCaseInsensitiveContains(query) }
            .sorted { $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt }
        let today = calendar.startOfDay(for: now)
        let yesterday = calendar.date(byAdding: .day, value: -1, to: today) ?? today
        let sections = [
            ("今天", filtered.filter { $0.updatedDate >= today }),
            ("昨天", filtered.filter { $0.updatedDate >= yesterday && $0.updatedDate < today }),
            ("更早", filtered.filter { $0.updatedDate < yesterday })
        ]
        return sections.filter { !$0.1.isEmpty }.map { Self(title: $0.0, conversations: $0.1) }
    }
}

struct AssistantView: View {
    @StateObject private var store: AssistantStore
    @State private var query = ""
    @State private var openedConversation: AssistantConversation?
    @State private var archiveTarget: AssistantConversation?
    @State private var showingCapabilities = false
    let launch: AssistantLaunchIntent?
    let onLaunchCheckpoint: ((AssistantLaunchIntent, DailyReviewCheckpoint) -> Bool)?

    init(api: APIClient, launch: AssistantLaunchIntent? = nil,
         onLaunchCheckpoint: ((AssistantLaunchIntent, DailyReviewCheckpoint) -> Bool)? = nil) {
        _store = StateObject(wrappedValue: AssistantStore(api: api))
        self.launch = launch; self.onLaunchCheckpoint = onLaunchCheckpoint
    }

    var body: some View {
        List {
            Section {
                HStack(alignment: .top, spacing: 14) {
                    Image(systemName: "sparkles")
                        .font(.title2).foregroundStyle(AppTheme.accent)
                        .frame(width: 48, height: 48)
                        .background(AppTheme.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 15))
                    VStack(alignment: .leading, spacing: 5) {
                        Text("把账本里的事，聊明白").font(.headline)
                        Text("记收支、关联退款、管理资金，也能整理历史账单。")
                            .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }.padding(.vertical, 8)
                if store.providerEnabled == false {
                    NavigationLink { ProviderSettingsView(api: store.api) } label: {
                        Label("配置 AI，开始第一段对话", systemImage: "slider.horizontal.3")
                            .font(.subheadline).foregroundStyle(AppTheme.accent)
                    }
                }
                Button("助手能做什么", systemImage: "square.grid.2x2") { showingCapabilities = true }
            }
            if let error = store.listError {
                Section {
                    AssistantNotice(message: error, buttonTitle: "重试") { Task { await store.loadConversations() } }
                }
            }
            if store.loadingList && store.conversations.isEmpty {
                Section { HStack { ProgressView(); Text("正在读取对话…").foregroundStyle(.secondary) }.padding(.vertical, 18) }
            } else if store.conversations.isEmpty && store.listError == nil {
                Section {
                    ContentUnavailableView {
                        Label("还没有对话", systemImage: "bubble.left.and.bubble.right")
                    } description: {
                        Text("从一个问题开始，例如「这个月主要花在哪儿？」")
                    } actions: {
                        Button("新建对话", systemImage: "square.and.pencil") { create() }
                            .buttonStyle(.borderedProminent).tint(AppTheme.accent).disabled(store.creating)
                    }
                }.listRowBackground(Color.clear)
            } else {
                let groups = AssistantConversationGroup.make(store.conversations, query: query)
                if groups.isEmpty {
                    ContentUnavailableView.search(text: query).listRowBackground(Color.clear)
                }
                ForEach(groups) { group in
                    Section(group.title) {
                        ForEach(group.conversations) { conversation in
                            Button { openedConversation = conversation } label: {
                                AssistantConversationRow(conversation: conversation, selected: store.selectedID == conversation.id,
                                                         archiving: store.archivingID == conversation.id)
                            }
                            .buttonStyle(.plain)
                            .disabled(store.archivingID == conversation.id)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button { archiveTarget = conversation } label: { Label("归档", systemImage: "archivebox") }
                                    .tint(.orange).disabled(store.archivingID != nil || store.thread(conversation.id).sending)
                            }
                            .contextMenu {
                                Button { archiveTarget = conversation } label: { Label("归档对话", systemImage: "archivebox") }
                                    .disabled(store.archivingID != nil || store.thread(conversation.id).sending)
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("AI 助手")
        .searchable(text: $query, prompt: "搜索对话标题")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                NavigationLink { ProviderSettingsView(api: store.api) } label: { Image(systemName: "slider.horizontal.3") }
                    .accessibilityLabel("AI 配置")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: create) {
                    if store.creating { ProgressView() } else { Image(systemName: "square.and.pencil") }
                }.accessibilityLabel("新建对话").disabled(store.creating || store.archivingID != nil)
            }
        }
        .navigationDestination(item: $openedConversation) { conversation in
            AssistantChatView(store: store, conversation: conversation)
        }
        .sheet(isPresented: $showingCapabilities) {
            NavigationStack { AssistantCapabilityView(assistant: store) { item in
                Task { if let conversation = await store.beginCapability(item) { openedConversation = conversation } }
            } }
        }
        .task(id: launch?.presentationID) {
            guard let launch, let onLaunchCheckpoint else { return }
            if let conversation = await store.launchDailyReview(launch, checkpoint: onLaunchCheckpoint), !Task.isCancelled { openedConversation = conversation }
        }
        .onReceive(NotificationCenter.default.publisher(for: .jizhangNativeWorkspaceCompleted).receive(on: RunLoop.main)) { notification in
            guard let completion = notification.object as? NativeWorkspaceCompletion,
                  completion.apiIdentity == store.api.identity else { return }
            Task { await store.continueNativeCompletion(completion) }
        }
        .confirmationDialog("归档这段对话？", isPresented: Binding(get: { archiveTarget != nil }, set: { if !$0 { archiveTarget = nil } }), titleVisibility: .visible) {
            Button("归档对话", role: .destructive) {
                guard let target = archiveTarget else { return }
                archiveTarget = nil
                Task { await store.archive(target) }
            }
            Button("取消", role: .cancel) { archiveTarget = nil }
        } message: { Text("对话会从列表移除，正在进行的回复也会停止。账本数据不受影响。") }
        .refreshable { await store.loadConversations(); await store.loadProviderStatus() }
        .task { await store.loadConversations(); await store.loadProviderStatus(); await store.loadCapabilities() }
    }

    private func create() {
        Task { if let conversation = await store.createConversation() { openedConversation = conversation } }
    }
}

private struct AssistantConversationRow: View {
    let conversation: AssistantConversation
    let selected: Bool
    let archiving: Bool
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "bubble.left")
                .font(.system(size: 19, weight: .medium)).foregroundStyle(AppTheme.accent)
                .frame(width: 38, height: 38).background(AppTheme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 7) {
                Text(conversation.displayTitle).font(.body.weight(.medium)).foregroundStyle(.primary)
                    .lineLimit(2).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 7) {
                    Text(conversation.updatedDate, format: .dateTime.month(.abbreviated).day().hour().minute())
                    if selected { Text("最近打开").foregroundStyle(AppTheme.accent) }
                }.font(.caption).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
            if archiving { ProgressView().controlSize(.small) }
            else { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary).padding(.top, 11) }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 7).contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct AssistantBottomPosition: PreferenceKey {
    static var defaultValue: CGFloat = .zero
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct AssistantChatView: View {
    @ObservedObject var store: AssistantStore
    let conversation: AssistantConversation
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var composerFocused: Bool
    @State private var followTail = true
    @State private var atBottom = true
    @State private var dragging = false
    @State private var hasNewContent = false
    @State private var actionReview: AssistantActionReview?
    @State private var draftRevision: AssistantActionReview?
    @State private var showingCapabilities = false
    @State private var pickingFile = false
    @State private var fileError: String?
    private var state: AssistantThread { store.thread(conversation.id) }

    var body: some View {
        VStack(spacing: 0) {
            if let status = state.statusLabel {
                HStack(spacing: 7) {
                    if state.isGenerating && !state.reconnectNeeded { ProgressView().controlSize(.mini) }
                    Text(status).font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }.padding(.horizontal, 20).padding(.vertical, 8).background(Color(uiColor: .secondarySystemGroupedBackground))
            }
            if let notice = state.notice {
                AssistantNotice(message: notice,
                    buttonTitle: (state.pendingSubmission != nil || state.pendingFileSubmission != nil) && !state.isGenerating ? "核对并重试" : (state.reconnectNeeded ? "继续接收" : "刷新对话")) {
                    Task {
                        if state.pendingFileSubmission != nil { await store.retryFile(in: conversation.id) }
                        else if state.pendingSubmission != nil && !state.isGenerating { await store.retrySubmission(in: conversation.id) }
                        else { await store.reconnect(in: conversation.id) }
                    }
                }.disabled(state.sending || state.stopping).padding(.horizontal, 16).padding(.vertical, 8)
            }
            if let notice = state.actionNotice {
                Text(notice).font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.vertical, 8)
            }
            if let request = state.workflow?["originalRequest"].stringValue {
                DisclosureGroup("当前任务") { Text(request).font(.caption).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    .font(.caption.weight(.medium)).foregroundStyle(.secondary).padding(.horizontal, 20).padding(.vertical, 6)
            }
            if let generation = state.generation, state.isGenerating {
                AssistantTraceView(api: store.api, conversationID: conversation.id, generationID: generation.id,
                    autoExpand: false, active: true).padding(.horizontal, 20).padding(.vertical, 8)
            }
            timeline
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .navigationTitle(conversation.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("助手能做什么", systemImage: "square.grid.2x2") { showingCapabilities = true }
                    Button("刷新对话", systemImage: "arrow.clockwise") { Task { await store.open(conversation.id) } }
                        .disabled(state.sending || state.stopping || state.actingID != nil)
                    Button("整理历史账单", systemImage: "wand.and.stars") {
                        store.setDraft("请先询问我要整理的日期范围，再预览历史账单的分类和标签建议；先不要修改，等我选择并确认。", for: conversation.id)
                        composerFocused = true
                    }.disabled(state.composerLocked)
                    NavigationLink { ProviderSettingsView(api: store.api) } label: { Label("AI 配置", systemImage: "slider.horizontal.3") }
                } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel("对话操作")
            }
        }
        .task(id: conversation.id) { await store.open(conversation.id) }
        .onDisappear { store.leave(conversation.id) }
        .sheet(item: $actionReview) { review in
            NavigationStack { AssistantActionReviewView(store: store, conversationID: conversation.id, review: review) }
        }
        .sheet(item: $draftRevision) { review in
            NavigationStack { AssistantDraftRevisionView(assistant: store, conversationID: conversation.id, card: review.card) }
        }
        .sheet(isPresented: $showingCapabilities) {
            NavigationStack { AssistantCapabilityView(assistant: store) { item in
                if let name = item["name"].stringValue {
                    store.setDraft("请帮我使用「\(AssistantToolPresentation.title(name))」（\(name)），缺少信息时用选择卡询问，修改前先展示预览。", for: conversation.id)
                    Task { await store.sendText(in: conversation.id) }
                }
            } }
        }
        .fileImporter(isPresented: $pickingFile, allowedContentTypes: [.commaSeparatedText, UTType(filenameExtension: "xlsx") ?? .data]) { result in
            do {
                let file = try AssistantBillFile.read(result.get())
                Task { await store.sendFile(file, in: conversation.id) }
            } catch { fileError = error.localizedDescription }
        }
        .alert("账单文件", isPresented: Binding(get: { fileError != nil }, set: { if !$0 { fileError = nil } })) {
            Button("知道了", role: .cancel) { fileError = nil }
        } message: { Text(fileError ?? "") }
    }

    private var timeline: some View {
        ScrollViewReader { proxy in
            GeometryReader { viewport in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        if state.loading && !state.loaded {
                            HStack { Spacer(); ProgressView("正在读取消息…"); Spacer() }.padding(.vertical, 80)
                        } else if state.messages.isEmpty && !state.loading {
                            welcome
                        }
                        ForEach(state.messages) { message in
                            AssistantMessageBubble(api: store.api, assistant: store, message: message,
                                showsTrace: !(state.isGenerating && message.content.generationId == state.generation?.id) && message.id == state.messages.last(where: { $0.content.generationId == message.content.generationId })?.id,
                                mayAnswer: store.canAnswer(message, in: conversation.id),
                                mayConfirm: message.content.card.map { store.canAct(on: $0, in: conversation.id) } ?? false,
                                mayCancel: message.content.card.map { store.canAct(on: $0, in: conversation.id, confirm: false) } ?? false,
                                onReview: { card in actionReview = AssistantActionReview(card: card) },
                                onRevise: { card in draftRevision = AssistantActionReview(card: card) },
                                onCancel: { card in Task { await store.performAction(card, in: conversation.id, confirm: false) } },
                                onSuggestion: { text in store.useSuggestion(text, in: conversation.id); composerFocused = true }) { option in
                                Task { await store.answer(option, message: message, in: conversation.id) }
                            }.id(message.id)
                        }
                        if state.isGenerating && state.generation?.partials.isEmpty != false {
                            HStack(spacing: 10) {
                                ProgressView().tint(AppTheme.accent)
                                Text(state.generation?.delivery == .buffered ? "正在准备回复…" : "正在思考…")
                                    .font(.subheadline).foregroundStyle(.secondary)
                            }.padding(16).background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
                        }
                        if let error = state.generation?.error, !state.messages.contains(where: { $0.content.error != nil && $0.content.generationId == state.generation?.id }) {
                            Label(error.displayMessage, systemImage: "exclamationmark.circle")
                                .font(.subheadline).foregroundStyle(.secondary).padding(16)
                        }
                        Color.clear.frame(height: 1).id("assistant-bottom")
                            .background(GeometryReader { geometry in
                                Color.clear.preference(key: AssistantBottomPosition.self, value: geometry.frame(in: .named("assistant-scroll")).maxY)
                            })
                    }.padding(.horizontal, 16).padding(.top, 20).padding(.bottom, 12)
                }
                .coordinateSpace(name: "assistant-scroll")
                .scrollDismissesKeyboard(.interactively)
                .simultaneousGesture(DragGesture(minimumDistance: 4).onChanged { _ in
                    dragging = true; followTail = false
                }.onEnded { _ in
                    dragging = false
                    if atBottom { followTail = true; hasNewContent = false }
                })
                .onPreferenceChange(AssistantBottomPosition.self) { bottom in
                    atBottom = bottom <= viewport.size.height + 24 && bottom >= 0
                    if atBottom && !dragging { followTail = true; hasNewContent = false }
                }
                .onChange(of: state.messages.count) { _, _ in followChange(proxy) }
                .onChange(of: state.generation?.lastSeq) { _, _ in followChange(proxy) }
                .onChange(of: state.loading) { _, loading in if !loading { followChange(proxy) } }
                .onChange(of: composerFocused) { _, focused in if focused && followTail { scrollBottom(proxy) } }
                .overlay(alignment: .bottom) {
                    if hasNewContent && !atBottom {
                        Button {
                            followTail = true; hasNewContent = false
                            if reduceMotion { proxy.scrollTo("assistant-bottom", anchor: .bottom) }
                            else { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("assistant-bottom", anchor: .bottom) } }
                        } label: { Label("有新回复", systemImage: "arrow.down").font(.subheadline.weight(.medium)) }
                            .buttonStyle(.borderedProminent).tint(AppTheme.accent).clipShape(Capsule()).padding(.bottom, 10)
                    }
                }
            }
        }
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 22) {
            Image(systemName: "sparkles").font(.system(size: 34)).foregroundStyle(AppTheme.accent)
                .frame(width: 72, height: 72).background(AppTheme.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 24))
            VStack(alignment: .leading, spacing: 8) {
                Text("今天，想聊点什么？").font(.title2.bold())
                Text("从你的账本出发，一起看看收支和计划。")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(["帮我记一笔今天的午餐支出，28 元", "记录一笔收入，请先帮我选择账户和分类", "整理这个月的历史账单，先给我分类和标签建议", "帮我检查四用途资金和待分配收入"], id: \.self) { question in
                Button {
                    store.setDraft(question, for: conversation.id); composerFocused = true
                } label: {
                    HStack(spacing: 12) {
                        Text(question).font(.subheadline).multilineTextAlignment(.leading)
                        Spacer(minLength: 4)
                        Image(systemName: "arrow.up.left").font(.caption)
                    }.foregroundStyle(.primary).padding(16)
                        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
                }.buttonStyle(.plain).disabled(state.composerLocked)
            }
        }.padding(.vertical, 30).frame(maxWidth: .infinity, alignment: .leading)
    }

    private var composer: some View {
        VStack(spacing: 6) {
            HStack(alignment: .bottom, spacing: 10) {
                Button { pickingFile = true } label: {
                    Image(systemName: "paperclip").font(.system(size: 20))
                        .frame(width: 36, height: 46)
                }.disabled(state.composerLocked).accessibilityLabel("附加微信或支付宝账单")
                TextField("说说你的问题…", text: Binding(get: { state.draft }, set: { store.setDraft($0, for: conversation.id) }), axis: .vertical)
                    .font(.body).lineLimit(1...5).padding(.horizontal, 15).padding(.vertical, 12)
                    .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 22))
                    .focused($composerFocused).disabled(state.composerLocked)
                    .accessibilityLabel("消息输入")
                if state.isGenerating {
                    Button { Task { await store.stop(in: conversation.id) } } label: {
                        if state.stopping { ProgressView().tint(.white) }
                        else { Image(systemName: "stop.fill").font(.system(size: 16, weight: .bold)).foregroundStyle(.white) }
                    }.frame(width: 46, height: 46).background(AppTheme.accent, in: Circle())
                        .disabled(state.stopping).accessibilityLabel("停止生成")
                } else {
                    Button {
                        followTail = true
                        Task { await store.sendText(in: conversation.id) }
                    } label: {
                        if state.sending { ProgressView().tint(.white) }
                        else { Image(systemName: "arrow.up").font(.system(size: 20, weight: .semibold)).foregroundStyle(.white) }
                    }.frame(width: 46, height: 46)
                        .background(state.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || state.composerLocked ? Color.secondary.opacity(0.35) : AppTheme.accent, in: Circle())
                        .disabled(state.composerLocked || state.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityLabel("发送消息")
                }
            }
            if state.draft.utf16.count > 1_800 {
                Text("\(state.draft.utf16.count) / 2,000").font(.caption2)
                    .foregroundStyle(state.draft.utf16.count > 2_000 ? Color.red : Color.secondary)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }.padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 10).background(.bar)
    }

    private func followChange(_ proxy: ScrollViewProxy) {
        if followTail && !dragging { scrollBottom(proxy) }
        else { hasNewContent = true }
    }

    private func scrollBottom(_ proxy: ScrollViewProxy) {
        DispatchQueue.main.async { if followTail && !dragging { proxy.scrollTo("assistant-bottom", anchor: .bottom) } }
    }
}

struct AssistantNotice: View {
    let message: String
    let buttonTitle: String
    let action: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(message, systemImage: "exclamationmark.circle")
                .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Button(buttonTitle, action: action).font(.subheadline.weight(.semibold)).tint(AppTheme.accent)
                .frame(minHeight: 36)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct AssistantMessageBubble: View {
    let api: APIClient
    @ObservedObject var assistant: AssistantStore
    let message: AssistantMessage
    let showsTrace: Bool
    let mayAnswer: Bool
    let mayConfirm: Bool
    let mayCancel: Bool
    let onReview: (JSONValue) -> Void
    let onRevise: (JSONValue) -> Void
    let onCancel: (JSONValue) -> Void
    let onSuggestion: (String) -> Void
    let onOption: (AssistantClarification.Option) -> Void
    private var user: Bool { message.role == "user" }
    @Environment(\.openJizhangWorkspace) private var openWorkspace
    private var importRoute: NativeWorkspaceRoute? {
        let batch = message.content.importBatch
        let id = batch?["batchId"].stringValue ?? batch?["id"].stringValue
        return NativeWorkspaceRoute(value: .object(["destination": .string("platform-import"), "conversationId": .string(message.conversationId), "batchId": id.map(JSONValue.string) ?? .null]))
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if user { Spacer(minLength: 34) }
            VStack(alignment: .leading, spacing: 12) {
                if let error = message.content.error {
                    Label(error.displayMessage, systemImage: "exclamationmark.circle").foregroundStyle(.secondary)
                } else if let text = message.content.text, !text.isEmpty {
                    Text(text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
                if let card = message.content.card { actionCard(card) }
                if let result = message.content.result, let summary = result["summary"].stringValue, !summary.isEmpty {
                    Label(summary, systemImage: "doc.text.magnifyingglass").font(.subheadline).textSelection(.enabled)
                    AssistantWorkspaceResultCard(assistant: assistant, conversationID: message.conversationId, messageID: message.id, result: result)
                }
                if let attachment = message.content.attachment {
                    Label(attachment["fileName"].stringValue ?? "附件", systemImage: "doc")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                if message.content.importBatch != nil {
                    Label("账单导入记录", systemImage: "tray.and.arrow.down").font(.subheadline.weight(.medium))
                    Text("打开导入工作区，核对文件、冲突和所选记录后再确认。")
                        .font(.caption).foregroundStyle(.secondary)
                    if let route = importRoute {
                        Button("打开导入工作区") { openWorkspace?(route) }.buttonStyle(.bordered).disabled(openWorkspace == nil)
                    }
                    DisclosureGroup("查看导入记录") { AssistantPreviewValues(value: message.content.importBatch ?? .null) }
                }
                // Diagnostic timeline for this reply. Rendered only when the server recorded a
                // generation id, so historical messages without a trace stay unchanged.
                if showsTrace, let generationID = message.content.generationId, !generationID.isEmpty {
                    AssistantTraceView(api: api, conversationID: message.conversationId,
                                       generationID: generationID,
                                       autoExpand: message.content.error != nil)
                        .id("\(api.identity):\(generationID)")
                }
                if let clarification = message.content.clarification, clarification.isValid {
                    Text(clarification.question).font(.headline)
                    ForEach(clarification.options) { option in
                        Button { onOption(option) } label: {
                            HStack { Text(option.label).multilineTextAlignment(.leading); Spacer(minLength: 8); Image(systemName: "arrow.up.right") }
                                .font(.subheadline.weight(.medium)).padding(.horizontal, 13).frame(minHeight: 46)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(.bordered).tint(AppTheme.accent).disabled(!mayAnswer)
                    }
                    Text(mayAnswer ? "也可以在下方输入补充说明。" : "历史问题，可继续发送新的消息。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let progress = message.content.progress, progress.state != "complete" {
                    Label(progress.state == "running" ? "正在处理请求" : "这次处理未完成", systemImage: progress.state == "running" ? "hourglass" : "exclamationmark.circle")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .font(.body).lineSpacing(4).padding(16)
            .background(user ? AppTheme.accent.opacity(0.13) : Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 21))
            .frame(maxWidth: .infinity, alignment: user ? .trailing : .leading)
            if !user { Spacer(minLength: 16) }
        }.accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func actionCard(_ card: JSONValue) -> some View {
        let pending = card["status"].stringValue == "pending"
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(pending ? "待确认草案" : statusName(card["status"].stringValue), systemImage: pending ? "doc.text" : "checkmark.circle")
                    .font(.caption.weight(.semibold)).foregroundStyle(AppTheme.accent)
                Spacer(minLength: 0)
            }
            Text(card["summary"].stringValue ?? "账本操作记录").font(.headline).textSelection(.enabled)
            if let count = card["affected"]["count"].intValue { Text("涉及 \(count) 项").font(.caption).foregroundStyle(.secondary) }
            if let cents = card["values"]["amountCents"].intValue {
                let amount = NSDecimalNumber(value: cents).dividing(by: NSDecimalNumber(value: 100))
                Text("¥\(amount.stringValue)").font(.title3.weight(.semibold)).monospacedDigit()
            }
            ForEach(Array((card["warnings"].arrayValue ?? []).compactMap(\.stringValue).enumerated()), id: \.offset) { _, warning in
                Label(warning, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary)
            }
            if pending {
                Text("尚未修改账本，请核对后确认。").font(.caption).foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 10) {
                    Button("查看并确认") { onReview(card) }.buttonStyle(.borderedProminent).disabled(!mayConfirm)
                    HStack(spacing: 12) {
                        Button("调整草案") { onRevise(card) }.buttonStyle(.bordered).disabled(!mayConfirm)
                        Button("取消草案", role: .cancel) { onCancel(card) }.buttonStyle(.bordered).disabled(!mayCancel)
                    }
                }.font(.subheadline)
            } else if card["status"].stringValue == "confirmed", assistant.workspaceCapabilities != nil {
                Button("继续原任务") { Task { await assistant.continueConfirmed(card, in: message.conversationId) } }
                    .font(.subheadline).disabled(assistant.thread(message.conversationId).composerLocked)
            }
        }.padding(13).background(AppTheme.accent.opacity(0.05), in: RoundedRectangle(cornerRadius: 14))
    }

    private func statusName(_ value: String?) -> String {
        switch value {
        case "confirmed": return "已确认的操作"
        case "cancelled": return "已取消"
        case "expired": return "草案已过期"
        case "failed": return "操作未完成"
        default: return "操作记录"
        }
    }
}
