import SwiftUI

/// 账单详情卡片：对齐 Android `TransactionDetailScreen.kt` 的居中浮动大卡片。
///
/// 结构：顶部「账单详情」标题 + ✕ → Hero（分类图块 / 分类名 / 备注 / 大金额）
/// → 分隔线 + 紧凑属性列表（分类/时间/账户/备注/资金用途/状态/标签/原支出）
/// → 底部胶囊按钮行（编辑 / 记录退款 / 删除）。
///
/// 这个视图只负责卡片本身。账单页与首页用 `LedgerBillDetailOverlay` 把它居中浮起；
/// 物品详情等既有系统 sheet 入口继续通过 `LedgerBillDetailSheet` 复用同一张卡片。
@MainActor struct LedgerBillDetailCard: View {
    let api: APIClient
    let transactionID: String
    let metadata: LedgerMetadata
    /// 关闭回调。为 `nil` 时不显示 ✕ 并禁用下滑关闭（由宿主容器自行关闭）。
    var onClose: (() -> Void)? = nil
    /// AI 复核等只读场景复用同一张卡片，但不暴露任何账本写操作。
    var readOnly = false

    @StateObject private var resource = LedgerResource<LedgerTransaction>()
    @State private var trail: [String] = []
    @State private var editSelection: LedgerBillCardEdit?
    @State private var confirmingDelete = false
    @State private var deleting = false
    @State private var deleteError: String?
    @State private var dragOffset: CGFloat = 0

    private var currentID: String { trail.last ?? transactionID }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let value = resource.value {
                        hero(value)
                        Divider().overlay(Color(uiColor: .separator).opacity(0.4))
                        attributes(value)
                        if !readOnly { actionArea(value) }
                    } else if resource.loading {
                        loadingState
                    }
                    if let error = resource.error {
                        errorState(error)
                    }
                }
                .padding(.horizontal, 22)
                .padding(.bottom, 20)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous)
            .strokeBorder(Color(uiColor: .separator).opacity(0.35), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.18), radius: 24, y: 12)
        .offset(y: dragOffset)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .sheet(item: $editSelection) { selection in
            LedgerTransactionEditor(api: api,
                                    transaction: selection.refund ? nil : selection.transaction,
                                    refundOf: selection.refund ? selection.transaction : nil) {
                editSelection = nil
            }
        }
        .confirmationDialog("删除这笔账单？", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("确认删除", role: .destructive) { delete() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("删除后账单移入回收站，账本合计会立即更新。")
        }
        .task(id: "\(currentID):\(api.ledgerRevision)") { await load() }
    }

    // MARK: - 顶部标题与关闭

    private var header: some View {
        HStack(spacing: 8) {
            if !trail.isEmpty {
                Button {
                    resource.clear()
                    _ = trail.popLast()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("返回上一笔关联账单")
            }
            Text("账单详情")
                .font(.headline.weight(.bold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            if let onClose {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("关闭账单详情")
            }
        }
        .padding(.leading, trail.isEmpty ? 20 : 2)
        .padding(.trailing, onClose == nil ? 20 : 2)
        .padding(.top, 8)
        .padding(.bottom, 2)
        .contentShape(Rectangle())
        .gesture(dismissDrag)
    }

    /// 下滑关闭只挂在标题栏上，避免与卡片内滚动内容抢手势。
    ///
    /// 手势总是存在、由闭包内部判断是否响应：SwiftUI 没有 `@GestureBuilder`，条件手势
    /// 只能靠 `some Gesture` 的 `@ViewBuilder` 写，那会直接编译失败。宿主 sheet 场景
    /// `onClose == nil`，此时拖动不产生位移也不触发关闭。
    private var dismissDrag: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                guard onClose != nil else { return }
                dragOffset = max(0, value.translation.height)
            }
            .onEnded { value in
                if onClose != nil, value.translation.height > 90 { onClose?() }
                withAnimation(.easeOut(duration: 0.18)) { dragOffset = 0 }
            }
    }

    // MARK: - Hero

    private func hero(_ value: LedgerTransaction) -> some View {
        let income = value.type == .income
        let subtitle = value.note.isEmpty ? value.kindTitle : value.note
        return VStack(spacing: 0) {
            ZStack {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(income ? AppTheme.accent.opacity(0.13) : Self.expenseTint.opacity(0.11))
                    .frame(width: 68, height: 68)
                Image(systemName: Self.categorySymbol(value, metadata: metadata))
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(income ? AppTheme.accent : Self.expenseTint)
            }
            .accessibilityHidden(true)

            Text(metadata.categoryName(value.categoryId))
                .font(.title3.weight(.bold))
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
                .padding(.top, 10)

            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .padding(.top, 3)

            Text(value.sign + LedgerFormat.money(value.amountCents))
                .font(.system(.largeTitle, design: .rounded).weight(.bold))
                .monospacedDigit()
                .foregroundStyle(Self.amountColor(value))
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .padding(.top, 6)
                .accessibilityLabel((income ? "收入 " : "支出 ") + LedgerFormat.money(value.amountCents))
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 6)
        .padding(.bottom, 14)
    }

    // MARK: - 属性列表

    private func attributes(_ value: LedgerTransaction) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            LedgerBillDetailRow(label: "分类", value: metadata.categoryName(value.categoryId))
            LedgerBillDetailRow(label: "时间", value: Self.detailDate(value.date))
            LedgerBillDetailRow(label: "账户", value: metadata.accountName(value.accountId))
            if !value.note.isEmpty {
                LedgerBillDetailRow(label: "备注", value: value.note)
            }
            if let purpose = value.fundPurpose {
                LedgerBillDetailRow(label: "资金用途", value: purpose.title)
            } else if value.type == .expense && !value.isRefund {
                LedgerBillDetailRow(label: "资金用途", value: "跟随分类规则")
            }
            LedgerBillDetailRow(label: "状态", value: Self.statusTitle(value), valueColor: Self.amountColor(value))
            if !value.tags.isEmpty {
                LedgerBillDetailRow(label: "标签", value: value.tags.map { "#" + $0 }.joined(separator: " · "))
            }
            if let refund = value.refundSummary, refund.refundCount > 0 {
                LedgerBillDetailRow(label: "关联退款",
                                    value: LedgerFormat.money(refund.totalRefundCents) + " · \(refund.refundCount) 笔")
                Text("普通收支中，退款单独计入收入，原支出金额保持不变。")
                    .font(.footnote).foregroundStyle(.secondary)
                    .padding(.bottom, 4)
            }
            if let details = value.refundDetails, !details.isEmpty {
                linkedGroup(title: "退款明细", items: details.map {
                    LedgerBillLinkedItem(id: $0.id,
                                         label: LedgerFormat.date($0.date),
                                         detail: "+" + LedgerFormat.money($0.amountCents))
                })
            }
            if let originalIDs = value.refundLinkedTxIds, !originalIDs.isEmpty {
                linkedGroup(title: "原支出", items: originalIDs.enumerated().map { index, id in
                    LedgerBillLinkedItem(id: id, label: "查看原始账单 \(index + 1)", detail: nil)
                })
            }
        }
    }

    private func linkedGroup(title: String, items: [LedgerBillLinkedItem]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.subheadline).foregroundStyle(.secondary).padding(.top, 6)
            ForEach(items) { item in
                Button {
                    openLinked(item.id)
                } label: {
                    HStack(spacing: 8) {
                        Text(item.label).font(.subheadline).foregroundStyle(.primary).lineLimit(2)
                        Spacer(minLength: 8)
                        if let detail = item.detail {
                            Text(detail).font(.subheadline.weight(.medium)).monospacedDigit()
                                .foregroundStyle(AppTheme.accent)
                        }
                        Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("打开这笔关联账单")
            }
        }
    }

    // MARK: - 底部胶囊按钮行

    private func actionArea(_ value: LedgerTransaction) -> some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                capsuleButton("编辑", fill: Color(uiColor: .tertiarySystemFill), textColor: .primary) {
                    editSelection = LedgerBillCardEdit(transaction: value, refund: false)
                }
                .accessibilityHint("打开账单编辑表单")
                if value.type == .expense && !value.isRefund {
                    capsuleButton("记录退款", fill: AppTheme.accent.opacity(0.14), textColor: AppTheme.accent) {
                        editSelection = LedgerBillCardEdit(transaction: value, refund: true)
                    }
                    .accessibilityHint("为这笔支出记录一笔关联退款收入")
                }
                capsuleButton(deleting ? "删除中…" : "删除",
                              fill: Self.deleteTint.opacity(0.12), textColor: Self.deleteTint) {
                    confirmingDelete = true
                }
                .disabled(deleting)
                .accessibilityHint("删除前会再次确认")
            }
            if let deleteError {
                Text(deleteError)
                    .font(.footnote).foregroundStyle(Self.deleteTint)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 2)
            }
        }
        .padding(.top, 8)
    }

    private func capsuleButton(_ title: String, fill: Color, textColor: Color,
                               action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(textColor)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(maxWidth: .infinity)
                .frame(minHeight: 44)
                .background(fill, in: Capsule(style: .continuous))
                .contentShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: - 状态视图

    private var loadingState: some View {
        VStack(spacing: 10) {
            ProgressView()
            Text("正在读取账单详情…").font(.footnote).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 10) {
            Text(message)
                .font(.footnote).foregroundStyle(Self.deleteTint)
                .multilineTextAlignment(.center)
            Button("重试") { Task { await load() } }
                .font(.subheadline.weight(.semibold))
                .frame(minWidth: 88, minHeight: 44)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
    }

    // MARK: - 动作

    private func load() async {
        let id = currentID
        await resource.load { try await api.request("/transactions/" + LedgerURL.segment(id)) }
    }

    private func openLinked(_ id: String) {
        guard !id.isEmpty, id != currentID else { return }
        resource.clear()
        trail.append(id)
    }

    /// 删除是新增的账本写能力：成功后广播 `ledgerRevision` 并关闭卡片。
    private func delete() {
        let id = currentID
        guard !deleting else { return }
        Task {
            deleting = true
            deleteError = nil
            do {
                let _: EmptyResponse = try await api.request("/transactions/" + LedgerURL.segment(id), method: "DELETE")
                deleting = false
                // 先关闭卡片，再广播账本变化：避免卡片在“已删除”的 id 上再读一次而闪现 404。
                if let onClose { onClose() } else { resource.clear() }
                api.notifyLedgerChanged()
            } catch {
                deleting = false
                deleteError = error.localizedDescription
            }
        }
    }

    // MARK: - 展示规则

    private static let expenseTint = Color(red: 0.87, green: 0.29, blue: 0.22)
    private static let deleteTint = Color(red: 0.87, green: 0.29, blue: 0.22)

    private static func amountColor(_ value: LedgerTransaction) -> Color {
        value.type == .income ? AppTheme.accent : Self.expenseTint
    }

    private static func statusTitle(_ value: LedgerTransaction) -> String {
        if value.isRefund { return "已退款" }
        return value.type == .income ? "已收入" : "已支出"
    }

    /// 服务端 `categories.icon` 语义值 → SF Symbol；未识别的值退回收支方向图标。
    private static func categorySymbol(_ value: LedgerTransaction, metadata: LedgerMetadata) -> String {
        if value.isRefund { return "arrow.uturn.backward" }
        let semantic = metadata.categories.first { $0.id == value.categoryId }?.icon
        switch semantic?.lowercased() {
        case "food": return "fork.knife"
        case "transport": return "car.fill"
        case "housing": return "house.fill"
        case "shopping": return "bag.fill"
        case "entertainment": return "gamecontroller.fill"
        case "salary": return "banknote.fill"
        case "medical": return "cross.case.fill"
        case "education": return "graduationcap.fill"
        case "pet", "pets": return "pawprint.fill"
        case "refund": return "arrow.uturn.backward"
        case "work": return "briefcase.fill"
        default: return value.type == .income ? "arrow.down.left" : "arrow.up.right"
        }
    }

    /// 「今天 HH:mm」「昨天 HH:mm」「M月d日 HH:mm」「yyyy年M月d日」，与安卓详情一致。
    private static func detailDate(_ milliseconds: Int64) -> String {
        let calendar = LedgerBillDates.calendar
        let date = Date(timeIntervalSince1970: Double(milliseconds) / 1_000)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "HH:mm"
        let clock = formatter.string(from: date)
        if calendar.isDateInToday(date) { return "今天 " + clock }
        if calendar.isDateInYesterday(date) { return "昨天 " + clock }
        let now = calendar.dateComponents([.year], from: Date()).year
        if calendar.dateComponents([.year], from: date).year == now {
            formatter.dateFormat = "M月d日 HH:mm"
            return formatter.string(from: date)
        }
        formatter.dateFormat = "yyyy年M月d日"
        return formatter.string(from: date)
    }
}

/// 卡片内的紧凑属性行：左侧标签固定列宽，右侧值换行不截断。
struct LedgerBillDetailRow: View {
    let label: String
    let value: String
    var valueColor: Color = .primary
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(width: 68, alignment: .leading)
            Text(value)
                .font(.subheadline)
                .foregroundStyle(valueColor)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
    }
}

private struct LedgerBillLinkedItem: Identifiable {
    let id: String
    let label: String
    let detail: String?
}

private struct LedgerBillCardEdit: Identifiable {
    let transaction: LedgerTransaction
    let refund: Bool
    var id: String { transaction.id + (refund ? ":refund" : ":edit") }
}

/// 居中浮动弹层：遮罩 + 卡片。点遮罩、点 ✕、下滑标题栏都关闭。
///
/// 之所以不用导航推入或系统 sheet，是为了让账单页的 Tab、查询条件、页码与滚动位置
/// 全部原地保留：浮层只是叠加在现有列表之上，关闭时视图状态没有任何重建。
@MainActor struct LedgerBillDetailOverlay: View {
    let api: APIClient
    let transactionID: String
    let metadata: LedgerMetadata
    let onDismiss: () -> Void

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                Color.black.opacity(0.35)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { onDismiss() }
                    .accessibilityLabel("关闭账单详情")
                    .accessibilityAddTraits(.isButton)
                LedgerBillDetailCard(api: api, transactionID: transactionID, metadata: metadata,
                                     onClose: onDismiss)
                    .frame(maxWidth: 345, maxHeight: max(280, proxy.size.height - 96))
                    .padding(.horizontal, 24)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
