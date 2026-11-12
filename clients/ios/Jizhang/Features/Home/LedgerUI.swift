import SwiftUI

@MainActor final class LedgerResource<Value>: ObservableObject {
    @Published private(set) var value: Value?
    @Published private(set) var error: String?
    @Published private(set) var loading = false
    private var generation = 0

    func load(_ operation: @MainActor () async throws -> Value) async {
        generation += 1
        let ticket = generation
        loading = true
        error = nil
        defer { if generation == ticket { loading = false } }
        do {
            let result = try await operation()
            guard generation == ticket, !Task.isCancelled else { return }
            value = result
        } catch {
            guard generation == ticket, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    func clear() {
        generation += 1
        value = nil
        error = nil
        loading = false
    }
}

struct LedgerCard<Content: View>: View {
    let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 24))
    }
}

struct LedgerSectionHeading: View {
    let title: String
    var subtitle: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.title3.weight(.bold))
            if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct LedgerLoadingView: View {
    var title = "正在读取…"
    var body: some View {
        HStack(spacing: 12) {
            ProgressView()
            Text(title).font(.subheadline).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity).padding(.vertical, 28)
    }
}

struct LedgerErrorView: View {
    let message: String
    var showingPrevious = false
    var retry: (() -> Void)? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(showingPrevious ? "刷新失败，当前为上次读取的数据" : "暂时无法读取", systemImage: "exclamationmark.circle")
                .font(.subheadline.weight(.semibold))
            Text(message).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
            if let retry { Button("重试", action: retry).buttonStyle(.bordered) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 18))
        .accessibilityElement(children: .contain)
    }
}

struct LedgerEmptyView: View {
    let title: String
    var message: String = "有新的记录后，会显示在这里。"
    var symbol: String = "tray"
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 30, weight: .light)).foregroundStyle(AppTheme.accent)
            Text(title).font(.headline)
            Text(message).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity).padding(.vertical, 28)
    }
}

struct LedgerMetric: View {
    let title: String
    let value: String
    var tint: Color = .primary
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold)).monospacedDigit().foregroundStyle(tint)
                .minimumScaleFactor(0.7).lineLimit(1)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct LedgerSymbol: View {
    let name: String
    var color: Color = AppTheme.accent
    var body: some View {
        Image(systemName: name).font(.system(size: 18, weight: .semibold))
            .foregroundStyle(color).frame(width: 42, height: 42)
            .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
            .accessibilityHidden(true)
    }
}

struct LedgerTransactionRow: View {
    let transaction: LedgerTransaction
    let metadata: LedgerMetadata
    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            LedgerSymbol(name: transaction.isRefund ? "arrow.uturn.backward" : (transaction.type == .income ? "arrow.down.left" : "arrow.up.right"), color: transaction.type == .income ? AppTheme.accent : .primary)
            VStack(alignment: .leading, spacing: 5) {
                Text(transaction.note.isEmpty ? metadata.categoryName(transaction.categoryId) : transaction.note)
                    .font(.subheadline.weight(.medium)).foregroundStyle(.primary).lineLimit(2)
                Text(metadata.categoryName(transaction.categoryId) + " · " + metadata.accountName(transaction.accountId))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 5) {
                Text(transaction.sign + LedgerFormat.money(transaction.amountCents))
                    .font(.subheadline.weight(.semibold)).monospacedDigit()
                    .foregroundStyle(transaction.type == .income ? AppTheme.accent : Color.primary)
                if transaction.isRefund { Text("退款").font(.caption2).foregroundStyle(AppTheme.accent) }
            }
        }.padding(.vertical, 5)
            // A plain-styled Button only hit-tests its drawn subviews, so the gap between the note
            // and the amount used to be inert. Fill the row's own frame with the tap target.
            .contentShape(Rectangle())
    }
}

struct LedgerFieldRow: View {
    let title: String
    let value: String
    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            Text(title).foregroundStyle(.secondary)
            Spacer(minLength: 12)
            Text(value).multilineTextAlignment(.trailing).textSelection(.enabled)
        }.font(.subheadline).padding(.vertical, 3)
    }
}

struct LedgerAvailabilityView: View {
    let title: String
    let symbol: String
    let message: String
    var body: some View {
        ScrollView {
            LedgerCard {
                LedgerEmptyView(title: title, message: message, symbol: symbol)
                Text("当前 iOS 版本先提供浏览功能。现有数据仍保存在服务器，可继续通过现有客户端管理。")
                    .font(.footnote).foregroundStyle(.secondary)
            }.padding(20)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
    }
}
