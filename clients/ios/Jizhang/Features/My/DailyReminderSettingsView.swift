import SwiftUI
import UIKit

@MainActor struct DailyReminderSettingsView: View {
    @EnvironmentObject private var store: DailyReminderStore
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Form {
            Section {
                Label(store.statusText, systemImage: store.authorization.allowsDelivery ? "bell.badge" : "bell.slash")
                    .font(.subheadline)
                if store.authorization == .notDetermined {
                    Button("允许每日通知") { Task { await store.allowNotifications() } }
                        .disabled(store.requestingPermission)
                } else if store.authorization == .denied {
                    Button("打开系统通知设置") {
                        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }
                if store.requestingPermission { ProgressView("正在请求通知权限…") }
                if let notice = store.notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
            } footer: {
                Text("通知展示受系统权限、专注模式和通知摘要设置影响。通知中不展示你的金额、账户或账单内容。")
            }
            Section("提醒记账") {
                Toggle("每天提醒记账", isOn: Binding(get: { store.preferences.recordingEnabled }, set: store.setRecordingEnabled))
                DatePicker("提醒时间", selection: Binding(get: { store.preferences.recordingTime.date }, set: store.setRecordingTime), displayedComponents: .hourAndMinute)
                    .disabled(!store.preferences.recordingEnabled)
                Text("点击通知打开记账，保存前不会记录任何账单。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section("每日复盘") {
                Toggle("每天提醒复盘", isOn: Binding(get: { store.preferences.reviewEnabled }, set: store.setReviewEnabled))
                    .disabled(!store.canReview)
                DatePicker("提醒时间", selection: Binding(get: { store.preferences.reviewTime.date }, set: store.setReviewTime), displayedComponents: .hourAndMinute)
                    .disabled(!store.preferences.reviewEnabled || !store.canReview)
                Text(store.canReview
                     ? "点击通知后，AI 才会生成该次提醒日期的复盘；通知到点不会自动调用模型。复盘日期按账本的北京时间显示。"
                     : "当前记账服务暂不支持通知复盘；仍可在 AI 助手中手动复盘，记账提醒也可继续使用。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section {
                Button("刷新提醒状态") { Task { await store.refresh() } }
                    .disabled(store.scheduling || store.requestingPermission)
            } footer: {
                Text("提醒时间跟随设备本地时钟。设置仅属于当前服务器和账号；退出登录后会取消该账号的待发提醒。")
            }
        }
        .navigationTitle("每日提醒")
        .task { await store.refresh() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await store.refresh() } } }
    }
}
