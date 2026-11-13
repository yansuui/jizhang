import SwiftUI

/// Shared detail content for the full-screen centred modal and existing item-detail sheets.
/// Header and actions stay visible in portrait; long bill details scroll within the card.
@MainActor struct LedgerBillDetailCard: View {
    @ObservedObject var api: APIClient
    let transactionID: String
    let metadata: LedgerMetadata
    /// 关闭回调。为 `nil` 时不显示 ✕ 并禁用下滑关闭（由宿主容器自行关闭）。
    var onClose: (() -> Void)? = nil
    /// AI 复核等只读场景复用同一张卡片，但不暴露任何账本写操作。
    var readOnly = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    @StateObject private var resource = LedgerResource<LedgerTransaction>()
    @StateObject private var allocation = LedgerIncomeAllocationStore()
    @State private var trail: [String] = []
    @State private var editSelection: LedgerBillCardEdit?
    @State private var confirmingDelete = false
    @State private var confirmingAllocation = false
    @State private var allocating = false
    @State private var deleting = false
    @State private var deleteError: String?
    @State private var dragOffset: CGFloat = 0

    private var currentID: String { trail.last ?? transactionID }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let value = resource.value {
                        hero(value)
                        attributes(value)
                            .padding(14)
                            .background(Color(uiColor: .systemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
                        if !readOnly, verticalSizeClass == .compact { actionArea(value) }
                    } else if resource.loading {
                        loadingState
                    }
                    if let error = resource.error {
                        errorState(error)
                    }
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 18)
            }
            .scrollBounceBehavior(.basedOnSize)
            if let value = resource.value, !readOnly, verticalSizeClass != .compact {
                Divider()
                actionArea(value)
                    .padding(.horizontal, 18)
                    .padding(.bottom, 16)
            }
        }
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous)
            .strokeBorder(Color(uiColor: .separator).opacity(0.35), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.18), radius: 24, y: 12)
        .offset(y: dragOffset)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("bill-detail-card")
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
        .confirmationDialog("按当前比例拆四份？", isPresented: $confirmingAllocation, titleVisibility: .visible) {
            Button("确认分配") { allocate() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("这笔收入会按当前四用途比例拆成四份，并冻结本次比例与金额。它不会记成工资，也不会出现在工资记录里；原账单保留。")
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
                .accessibilityIdentifier("bill-detail-close")
            }
        }
        .padding(.leading, trail.isEmpty ? 20 : 2)
        .padding(.trailing, onClose == nil ? 20 : 2)
        .padding(.top, 6)
        .padding(.bottom, 6)
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
        return VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Image(systemName: Self.categorySymbol(value, metadata: metadata))
                    .font(.system(size: 23, weight: .semibold))
                    .foregroundStyle(income ? AppTheme.accent : Self.expenseTint)
                    .frame(width: 48, height: 48)
                    .background(Self.amountColor(value).opacity(0.10), in: RoundedRectangle(cornerRadius: 15))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(metadata.categoryName(value.categoryId))
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(value.kindTitle).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            Text(value.sign + LedgerFormat.money(value.amountCents))
                .font(.system(.largeTitle, design: .rounded).weight(.bold))
                .monospacedDigit()
                .foregroundStyle(Self.amountColor(value))
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .accessibilityLabel((income ? "收入 " : "支出 ") + LedgerFormat.money(value.amountCents))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
    }

    // MARK: - 属性列表

    private func attributes(_ value: LedgerTransaction) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            LedgerBillDetailRow(label: "时间", value: Self.detailDate(value.date))
            LedgerBillDetailRow(label: "账户", value: metadata.accountName(value.accountId))
            if !value.note.isEmpty {
                LedgerBillDetailRow(label: "备注", value: value.note)
            }
            if let purpose = value.fundPurpose {
                LedgerBillDetailRow(label: "资金用途", value: purpose.title)
            } else if value.fundIncomeAllocated == true {
                LedgerBillDetailRow(label: "资金用途", value: "按比例分配（已确认）")
                Text("这笔收入按确认当时的比例拆进四用途，修改默认比例不会重算。")
                    .font(.footnote).foregroundStyle(.secondary)
                    .padding(.bottom, 4)
            } else if value.isRefund {
                LedgerBillDetailRow(label: "资金用途", value: "待按比例分配")
                Text("退款不占用单一用途：确认按比例拆四份后才计入余额。")
                    .font(.footnote).foregroundStyle(.secondary)
                    .padding(.bottom, 4)
            } else if value.type == .expense {
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
            if dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 8) { actionButtons(value) }
            } else {
                HStack(spacing: 8) { actionButtons(value) }
            }
            if let deleteError {
                Text(deleteError)
                    .font(.footnote).foregroundStyle(Self.deleteTint)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 2)
            }
            if let message = allocation.errors[value.id] {
                Text(message)
                    .font(.footnote).foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 2)
            }
        }
        .padding(.top, 12)
    }

    @ViewBuilder private func actionButtons(_ value: LedgerTransaction) -> some View {
        capsuleButton("编辑", fill: Color(uiColor: .tertiarySystemFill), textColor: .primary) {
            editSelection = LedgerBillCardEdit(transaction: value, refund: false)
        }
        .accessibilityHint("打开账单编辑表单")
        .accessibilityIdentifier("bill-detail-edit")
        if value.type == .expense && !value.isRefund {
            capsuleButton("记录退款", fill: AppTheme.accent.opacity(0.14), textColor: AppTheme.accent) {
                editSelection = LedgerBillCardEdit(transaction: value, refund: true)
            }
            .accessibilityHint("为这笔支出记录一笔关联退款收入")
        }
        if value.type == .income && value.fundIncomeAllocated != true {
            capsuleButton(allocating ? "分配中…" : "按比例拆四份",
                          fill: AppTheme.accent.opacity(0.14), textColor: AppTheme.accent) {
                confirmingAllocation = true
            }
            .disabled(allocating)
            .accessibilityIdentifier("bill-detail-allocate")
            .accessibilityHint("按当前四用途比例把这一笔收入拆成四份，不会记成工资")
        }
        capsuleButton(deleting ? "删除中…" : "删除",
                      fill: Self.deleteTint.opacity(0.12), textColor: Self.deleteTint) {
            confirmingDelete = true
        }
        .disabled(deleting)
        .accessibilityHint("删除前会再次确认")
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

    /// 收入按当前比例拆四份：服务器为一笔交易保存分配决定，不写工资记录、不删除账单。
    private func allocate() {
        guard let value = resource.value, !allocating else { return }
        Task {
            allocating = true
            _ = await allocation.allocate(value, api: api)
            allocating = false
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    Text(label).font(.caption).foregroundStyle(.secondary)
                    detail(alignment: .leading)
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(label).font(.subheadline).foregroundStyle(.secondary)
                        .frame(width: 62, alignment: .leading)
                    detail(alignment: .trailing)
                }
            }
        }
        .padding(.vertical, 7)
        .accessibilityElement(children: .combine)
    }

    private func detail(alignment: HorizontalAlignment) -> some View {
        Text(value)
            .font(.subheadline)
            .foregroundStyle(valueColor)
            .frame(maxWidth: .infinity, alignment: alignment == .leading ? .leading : .trailing)
            .multilineTextAlignment(alignment == .leading ? .leading : .trailing)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
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

/// Full-screen dimming layer inside the native modal; only the centred card is scrollable.
@MainActor struct LedgerBillDetailOverlay: View {
    let api: APIClient
    let transactionID: String
    let metadata: LedgerMetadata
    let onDismiss: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                Color.black.opacity(0.35)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { onDismiss() }
                    .accessibilityLabel("关闭账单详情")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityIdentifier("bill-detail-backdrop")
                LedgerBillDetailCard(api: api, transactionID: transactionID, metadata: metadata,
                                     onClose: onDismiss)
                    .frame(width: min(390, max(0, proxy.size.width - 36)),
                           height: min(dynamicTypeSize.isAccessibilitySize ? 760 : 620,
                                       max(220, proxy.size.height - 40)))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .accessibilityIdentifier("bill-detail-modal")
    }
}
