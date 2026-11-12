import SwiftUI

enum AppTheme {
    static let accent = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.35, green: 0.83, blue: 0.66, alpha: 1)
            : UIColor(red: 0.08, green: 0.47, blue: 0.35, alpha: 1)
    })
}

@main
@MainActor
struct JizhangApp: App {
    @UIApplicationDelegateAdaptor(JizhangNotificationDelegate.self) private var notificationDelegate
    @StateObject private var session = AppSession()
    @StateObject private var reminders = DailyReminderStore.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                if let api = session.api, let user = session.user {
                    MainTabView(api: api, user: user, onLogout: {
                        NativeWorkspaceSessions.clear(apiIdentity: api.identity)
                        reminders.deactivate()
                        Task { await session.signOut() }
                    })
                        .id(api.identity)
                        .disabled(session.isBusy)
                        .overlay {
                            if session.isBusy {
                                ProgressView("正在退出…")
                                    .padding(24)
                                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
                            }
                        }
                } else {
                    LoginView(session: session)
                }
            }
            .environmentObject(reminders)
            .tint(AppTheme.accent)
            .task {
                await session.restore()
                reminders.updateSession(api: session.api, user: session.user)
            }
            .onChange(of: session.api?.identity) { old, _ in
                if let old { NativeWorkspaceSessions.clear(apiIdentity: old) }
                reminders.updateSession(api: session.api, user: session.user)
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await reminders.refresh() } }
            }
        }
    }
}

@MainActor
private struct MainTabView: View {
    let api: APIClient
    let user: AuthenticatedUser
    let onLogout: () -> Void
    @EnvironmentObject private var reminders: DailyReminderStore
    private enum Tab: Hashable { case home, bills, plan, assistant, my }
    @State private var selectedTab = Tab.home
    @State private var recording = false
    @State private var workspace: NativeWorkspaceRoute?
    @StateObject private var presentation: NativePresentationQueue
    @StateObject private var workspaceCompletions: NativeWorkspaceCompletionRelay
    @State private var recordingRequestID: UUID?
    @State private var workspaceRequestID: UUID?
    @State private var activeReviewID: String?
    @State private var assistantVisible = false
    @State private var presentedReview: UUID?
    @State private var presentationRetryCounts: [UUID: Int] = [:]

    init(api: APIClient, user: AuthenticatedUser, onLogout: @escaping () -> Void) {
        self.api = api; self.user = user; self.onLogout = onLogout
        _presentation = StateObject(wrappedValue: NativePresentationQueue(ownerIdentity: api.identity))
        _workspaceCompletions = StateObject(wrappedValue: NativeWorkspaceCompletionRelay(ownerIdentity: api.identity))
    }

    private var assistantLaunch: AssistantLaunchIntent? {
        guard selectedTab == .assistant, assistantVisible, !recording, workspace == nil,
              let activeReviewID, let current = reminders.authorizedReviewLaunches[activeReviewID],
              let presentedReview else { return nil }
        return AssistantLaunchIntent(id: current.id, apiIdentity: current.apiIdentity, date: current.date,
            timeZone: current.timeZone, clientRequestID: current.clientRequestID,
            conversationID: current.conversationID, mayStart: current.mayStart, presentationID: presentedReview)
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack { HomeView(api: api).toolbar { recordButton } }
                .tabItem { Label("首页", systemImage: "house") }
                .tag(Tab.home)
            NavigationStack { BillsView(api: api).toolbar { recordButton } }
                .tabItem { Label("账单", systemImage: "list.bullet.rectangle") }
                .tag(Tab.bills)
            NavigationStack { PlanView(api: api).toolbar { recordButton } }
                .tabItem { Label("计划", systemImage: "chart.pie") }
                .tag(Tab.plan)
            NavigationStack {
                AssistantView(api: api, launch: assistantLaunch, onLaunchCheckpoint: reminders.checkpoint)
            }
                .onAppear { assistantVisible = true }
                .onDisappear { assistantVisible = false }
                .tabItem { Label("AI 助手", systemImage: "sparkles") }
                .tag(Tab.assistant)
            NavigationStack { MyView(api: api, user: user, onLogout: onLogout) }
                .tabItem { Label("我的", systemImage: "person.crop.circle") }
                .tag(Tab.my)
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let notice = reminders.notice {
                HStack(alignment: .top, spacing: 12) {
                    Label(notice, systemImage: "bell.badge").font(.footnote)
                    Spacer(minLength: 0)
                    Button { reminders.clearNotice() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("关闭提醒提示")
                }
                .padding(12)
                .background(.regularMaterial)
            }
            if let notice = presentation.notice {
                HStack(alignment: .top, spacing: 12) {
                    Label(notice, systemImage: "clock")
                        .font(.footnote)
                    Spacer(minLength: 0)
                    Button("继续打开") { presentation.retry() }.font(.footnote.weight(.semibold))
                }
                .padding(12)
                .background(.regularMaterial)
            }
        }
        .environment(\.openJizhangWorkspace, { route in
            guard reminders.owner?.apiIdentity == api.identity else { return }
            presentation.enqueue(.workspace(route), owner: api.identity)
        })
        .environment(\.jizhangCanManageInvitations, user.canManageInvitations)
        .sheet(isPresented: $recording, onDismiss: retryPendingPresentation) {
            let requestID = recordingRequestID
            LedgerTransactionEditor(api: api, onSaved: { recording = false })
                .onAppear { if let requestID { presentation.acknowledgeAppearance(requestID) } }
        }
        .sheet(item: $workspace, onDismiss: workspaceDidDismiss) { route in
            let requestID = workspaceRequestID
            NativeWorkspaceView(api: api, user: user, route: route, onLogout: onLogout,
                                onCompletion: { completion in
                guard completion.conversationID == route.conversationID,
                      completion.sourceMessageID == route.sourceMessageID else { return }
                workspaceCompletions.store(completion, currentOwner: reminders.owner?.apiIdentity)
            })
                .environmentObject(reminders)
                .onAppear { if let requestID { presentation.acknowledgeAppearance(requestID) } }
        }
        .onChange(of: reminders.owner?.apiIdentity) { _, identity in
            if identity != api.identity { workspaceCompletions.clear() }
        }
        .onChange(of: reminders.recordingLaunch?.id) { _, _ in queueRecording() }
        .onChange(of: reminders.reviewLaunch?.presentationID) { _, _ in queueReview() }
        .task {
            queueRecording()
            queueReview()
        }
        .task(id: presentation.observationID) { await presentWhenAvailable() }
    }

    @ToolbarContentBuilder
    private var recordButton: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                // The editor is already up, so a second request would re-open it after dismissal.
                guard !recording, workspace == nil else { return }
                presentation.enqueue(.recording(DailyRecordingIntent(apiIdentity: api.identity)), owner: api.identity)
            } label: {
                Label("记一笔", systemImage: "plus.circle.fill")
            }.accessibilityLabel("记一笔收入或支出")
        }
    }

    private func queueRecording() {
        guard let intent = reminders.recordingLaunch, intent.apiIdentity == api.identity else { return }
        presentation.enqueue(.recording(intent), owner: api.identity)
    }

    private func queueReview() {
        guard let intent = reminders.reviewLaunch, intent.apiIdentity == api.identity else { return }
        presentation.enqueue(.review(intent), owner: api.identity)
    }

    private func retryPendingPresentation() {
        recordingRequestID = nil; workspaceRequestID = nil
        if presentation.first != nil { presentation.retry() }
    }

    private func workspaceDidDismiss() {
        if let completion = workspaceCompletions.takeAfterDismiss(currentOwner: reminders.owner?.apiIdentity) {
            NotificationCenter.default.post(name: .jizhangNativeWorkspaceCompleted, object: completion)
        }
        retryPendingPresentation()
    }

    private func presentWhenAvailable() async {
        guard let request = presentation.first else { return }
        let stillCurrent = { reminders.owner?.apiIdentity == api.identity && presentation.first?.id == request.id }
        let gate = NativePresentationGate(available: {
            !recording && workspace == nil && UIKitPresentationStatus.isFree()
        })
        let available = await gate.wait(stillCurrent: stillCurrent)
        guard available == .ready, !Task.isCancelled, stillCurrent() else {
            if available == .timedOut { deferPresentationAndRetry(request.id) }
            return
        }
        guard let current = presentation.first, presentation.beginPresentation(current.id) else { return }
        switch current.target {
        case .workspace(let route):
            workspaceRequestID = current.id
            workspace = route
        case .recording:
            recordingRequestID = current.id
            selectedTab = .home
            recording = true
        case .review(let intent):
            activeReviewID = intent.id
            presentedReview = nil
            selectedTab = .assistant
            let visible = await NativePresentationGate(available: {
                assistantVisible && selectedTab == .assistant && !recording && workspace == nil && UIKitPresentationStatus.isFree()
            }, maximumChecks: 80).wait(stillCurrent: stillCurrent)
            guard visible == .ready, !Task.isCancelled, stillCurrent(),
                  let latest = presentation.first, case .review(let latestIntent) = latest.target else {
                if visible == .timedOut { deferPresentationAndRetry(current.id) }
                return
            }
            presentedReview = latestIntent.presentationID
            presentation.acknowledgeAppearance(latest.id)
            return
        }
        // A binding change is only a presentation attempt. Keep the request until onAppear.
        let appeared = await NativePresentationGate(available: {
            presentation.first?.id != current.id
        }, maximumChecks: 80).wait(stillCurrent: { reminders.owner?.apiIdentity == api.identity })
        guard appeared == .timedOut, !Task.isCancelled, presentation.first?.id == current.id else { return }
        if workspaceRequestID == current.id { workspace = nil; workspaceRequestID = nil }
        if recordingRequestID == current.id { recording = false; recordingRequestID = nil }
        deferPresentationAndRetry(current.id)
    }

    /// A bounded wait can time out while UIKit is still draining an earlier transition. Keep the
    /// request and re-arm the observation, but only a few times: if the presenter stays unavailable
    /// the explicit "继续打开" button takes over, instead of retrying forever and flickering the
    /// notice.
    private func deferPresentationAndRetry(_ id: UUID) {
        presentation.deferPresentation(id)
        let attempts = (presentationRetryCounts[id] ?? 0) + 1
        presentationRetryCounts[id] = attempts
        guard attempts <= 3 else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled, reminders.owner?.apiIdentity == api.identity,
                  presentation.first?.id == id else { return }
            presentation.retry()
        }
    }
}
