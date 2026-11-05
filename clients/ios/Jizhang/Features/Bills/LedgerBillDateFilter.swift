import SwiftUI

struct LedgerBillDateFilter: View {
    @Binding var query: LedgerBillQuery
    @Environment(\.dismiss) private var dismiss
    @State private var mode = 0
    @State private var year: Int
    @State private var month: Int
    @State private var start: Date
    @State private var end: Date

    init(query: Binding<LedgerBillQuery>) {
        _query = query
        let first = query.wrappedValue.from.map { Date(timeIntervalSince1970: Double($0) / 1_000) } ?? Date()
        let last = query.wrappedValue.to.map { Date(timeIntervalSince1970: Double($0 - 1) / 1_000) } ?? Date()
        let parts = LedgerBillDates.calendar.dateComponents([.year, .month], from: first)
        _year = State(initialValue: parts.year ?? 2026)
        _month = State(initialValue: parts.month ?? 1)
        _start = State(initialValue: first)
        _end = State(initialValue: last)
        if query.wrappedValue.from != nil && !LedgerBillDates.isWholeMonth(query.wrappedValue) {
            _mode = State(initialValue: 1)
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Picker("日期方式", selection: $mode) {
                    Text("按月").tag(0)
                    Text("日期范围").tag(1)
                }.pickerStyle(.segmented)
                if mode == 0 {
                    Stepper("\(String(year))年", value: $year, in: 1970...2200)
                    Picker("月份", selection: $month) {
                        ForEach(1...12, id: \.self) { Text("\($0)月").tag($0) }
                    }
                } else {
                    DatePicker("开始日期", selection: $start, displayedComponents: .date)
                    DatePicker("结束日期", selection: $end, displayedComponents: .date)
                    if LedgerBillDates.range(start: start, end: end) == nil {
                        Text("结束日期不能早于开始日期。").foregroundStyle(.red)
                    }
                }
                Text("按北京时间筛选，包含结束日期当天；账户、关键词及其他筛选保持不变。")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("全部日期") { query.from = nil; query.to = nil; dismiss() }
            }
            .environment(\.timeZone, LedgerBillDates.calendar.timeZone)
            .navigationTitle("日期筛选").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("确定") { apply() }
                        .disabled(mode == 1 && LedgerBillDates.range(start: start, end: end) == nil)
                }
            }
        }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }

    private func apply() {
        let bounds: (from: Int64, to: Int64)?
        if mode == 0 {
            let date = LedgerBillDates.calendar.date(from: DateComponents(year: year, month: month, day: 1))!
            bounds = LedgerBillDates.month(containing: date)
        } else { bounds = LedgerBillDates.range(start: start, end: end) }
        guard let bounds else { return }
        query.from = bounds.from
        query.to = bounds.to
        dismiss()
    }
}
