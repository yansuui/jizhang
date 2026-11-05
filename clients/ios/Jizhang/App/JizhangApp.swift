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
    @StateObject private var session = AppSession()

    var body: some Scene {
        WindowGroup {
            Group {
                if let api = session.api, let user = session.user {
                    MainTabView(api: api, user: user, onLogout: { Task { await session.signOut() } })
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
            .tint(AppTheme.accent)
            .task { await session.restore() }
        }
    }
}

@MainActor
private struct MainTabView: View {
    let api: APIClient
    let user: AuthenticatedUser
    let onLogout: () -> Void
    @State private var recording = false

    var body: some View {
        TabView {
            NavigationStack { HomeView(api: api).toolbar { recordButton } }
                .tabItem { Label("首页", systemImage: "house") }
            NavigationStack { BillsView(api: api).toolbar { recordButton } }
                .tabItem { Label("账单", systemImage: "list.bullet.rectangle") }
            NavigationStack { PlanView(api: api).toolbar { recordButton } }
                .tabItem { Label("计划", systemImage: "chart.pie") }
            NavigationStack { AssistantView(api: api) }
                .tabItem { Label("AI 助手", systemImage: "sparkles") }
            NavigationStack { MyView(api: api, user: user, onLogout: onLogout) }
                .tabItem { Label("我的", systemImage: "person.crop.circle") }
        }
        .sheet(isPresented: $recording) {
            LedgerTransactionEditor(api: api, onSaved: { recording = false })
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
}
