import SwiftUI
import UniformTypeIdentifiers

@MainActor struct NativeCSVImportView: View {
    @StateObject private var store: NativeCSVImportStore
    @State private var picking = false
    @State private var fileError: String?
    init(api: APIClient) { _store = StateObject(wrappedValue: NativeWorkspaceSessions.csv(api)) }
    var body: some View {
        List {
            Section("通用账本 CSV") {
                Picker("导入类型", selection: Binding(get: { store.kind }, set: { store.setKind($0) })) {
                    Text("收支账单").tag("transactions")
                    Text("账户转账").tag("transfers")
                }.disabled(!store.mayChoose)
                Text("请使用本项目导出格式的 UTF-8 CSV，最大 2 MiB。先验证并预览，确认后导入整个文件。")
                    .font(.footnote).foregroundStyle(.secondary)
                Button(store.file?.name ?? "选择 CSV 文件") { picking = true }.disabled(!store.mayChoose)
                if let file = store.file {
                    Text("\(file.bytes.count) 字节").font(.caption).foregroundStyle(.secondary)
                    Button("验证并生成导入预览") { Task { await store.prepare() } }.disabled(!store.mayChoose || store.result != nil)
                }
                NavigationLink("导入微信 / 支付宝多文件") { NativeBatchImportView(api: store.api, conversationID: nil, batchID: nil) }
            }
            if let preview = store.preview {
                Section("预览与影响") {
                    Text("源文件共 \(preview["totalRows"].intValue.map(String.init) ?? "未知") 行")
                    AssistantPreviewValues(value: preview["result"])
                    if preview["rowsOmitted"].boolValue == true {
                        Text("下面仅展示前 100 行。确认会处理整个文件，新增与跳过数量以上方验证结果为准。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(Array((preview["rows"].arrayValue ?? []).enumerated()), id: \.offset) { index, row in
                        DisclosureGroup("第 \(index + 1) 行") {
                            let columns = preview["columns"].arrayValue ?? []
                            ForEach(Array((row.arrayValue ?? []).enumerated()), id: \.offset) { column, cell in
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(column < columns.count ? columns[column].stringValue ?? "字段" : "字段 \(column + 1)")
                                        .font(.caption).foregroundStyle(.secondary)
                                    Text(cell.stringValue ?? "").textSelection(.enabled)
                                }
                            }
                        }
                    }
                    if store.result == nil {
                        Button(store.uncertain ? "核对并重试原确认" : "确认导入整个文件") { Task { await store.confirm() } }
                            .buttonStyle(.borderedProminent).disabled(store.busy)
                    }
                }
            }
            if let result = store.result {
                Section("已完成") { Label("文件已处理", systemImage: "checkmark.circle.fill"); AssistantPreviewValues(value: result) }
            }
            if store.busy { ProgressView("正在处理…") }
            if let error = store.error ?? fileError { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("导入账本 CSV")
        .fileImporter(isPresented: $picking, allowedContentTypes: [.commaSeparatedText], allowsMultipleSelection: false) { result in
            do {
                guard let url = try result.get().first else { return }
                let file = try NativeBillFile.read(url, limit: 2 * 1_024 * 1_024)
                store.choose(file); fileError = nil
            } catch {
                if (error as NSError).code != NSUserCancelledError { fileError = error.localizedDescription }
            }
        }
    }
}

@MainActor struct NativeExportView: View {
    @StateObject private var store: NativeExportStore
    init(api: APIClient) { _store = StateObject(wrappedValue: NativeExportStore(api: api)) }
    private let kinds = [("transactions", "全部收支账单"), ("salaries", "工资与分配记录"),
                         ("recurring", "周期账单规则"), ("transfers", "账户转账")]
    var body: some View {
        List {
            Section {
                ForEach(kinds, id: \.0) { kind in Button(kind.1) { Task { await store.download(kind.0) } }.disabled(store.busy) }
            } header: { Text("导出 CSV") }
            footer: { Text("文件通过当前账号下载，可保存到「文件」或分享。不会向外部地址转交登录凭据。") }
            if store.busy { ProgressView("正在下载…") }
            if let error = store.error { Text(error).foregroundStyle(.red) }
            if let file = store.file {
                Section("下载完成") {
                    Text(file.lastPathComponent)
                    ShareLink(item: file) { Label("保存或分享 CSV", systemImage: "square.and.arrow.up") }
                }
            }
        }.navigationTitle("导出账本").onAppear { store.activate() }.onDisappear { store.stop() }
    }
}
