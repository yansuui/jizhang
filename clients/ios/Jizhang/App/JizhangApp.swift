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
    @State private var pendingRecording: DailyRecordingIntent?
    @State private var pendingReview: AssistantLaunchIntent?
    @State private var presentedReview: UUID?

    private var assistantLaunch: AssistantLaunchIntent? {
        guard selectedTab == .assistant, !recording, workspace == nil,
              reminders.reviewLaunch?.presentationID == presentedReview else { return nil }
        return reminders.reviewLaunch
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
        }
        .environment(\.openJizhangWorkspace, { route in
            guard reminders.owner?.apiIdentity == api.identity else { return }
            workspace = route
        })
        .environment(\.jizhangCanManageInvitations, user.canManageInvitations)
        .sheet(isPresented: $recording, onDismiss: applyPendingNotification) {
            LedgerTransactionEditor(api: api, onSaved: { recording = false })
        }
        .sheet(item: $workspace, onDismiss: applyPendingNotification) { route in
            NativeWorkspaceView(api: api, user: user, route: route, onLogout: onLogout)
                .environmentObject(reminders)
        }
        .onChange(of: reminders.recordingLaunch?.id) { _, _ in queueRecording() }
        .onChange(of: reminders.reviewLaunch?.presentationID) { _, _ in queueReview() }
        .task {
            if reminders.reviewLaunch != nil { queueReview() }
            else { queueRecording() }
        }
    }

    @ToolbarContentBuilder
    private var recordButton: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button { recording = true } label: {
                Label("记一笔", systemImage: "plus.circle.fill")
            }.accessibilityLabel("记一笔收入或支出")
        }
    }

    private func queueRecording() {
        guard let intent = reminders.recordingLaunch, intent.apiIdentity == api.identity else { return }
        pendingRecording = intent; pendingReview = nil
        applyPendingNotification()
    }

    private func queueReview() {
        guard let intent = reminders.reviewLaunch, intent.apiIdentity == api.identity else { return }
        pendingReview = intent; pendingRecording = nil
        applyPendingNotification()
    }

    private func applyPendingNotification() {
        guard !recording, workspace == nil, reminders.owner?.apiIdentity == api.identity else { return }
        if let intent = pendingReview, intent.apiIdentity == api.identity {
            pendingReview = nil
            presentedReview = intent.presentationID
            selectedTab = .assistant
        } else if let intent = pendingRecording, intent.apiIdentity == api.identity {
            pendingRecording = nil
            selectedTab = .home
            recording = true
        }
    }
}
