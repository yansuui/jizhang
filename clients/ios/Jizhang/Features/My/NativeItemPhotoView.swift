import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

@MainActor struct NativeItemPhotoView: View {
    @StateObject private var store: NativeItemPhotoStore
    let cutout: Bool
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var pickingFile = false
    @State private var removing = false
    @State private var saving = false
    @State private var fileError: String?
    @State private var refresh = UUID()
    @State private var pickingTask: Task<Void, Never>?
    init(api: APIClient, itemID: String, cutout: Bool) {
        _store = StateObject(wrappedValue: NativeWorkspaceSessions.photo(api, itemID: itemID)); self.cutout = cutout
    }
    var body: some View {
        List {
            Section("当前照片") {
                if let image = store.existing { photo(image) }
                else { Label("尚未保存照片", systemImage: "photo") }
                HStack {
                    PhotosPicker(selection: $selectedPhoto, matching: .images) { Label("从照片选择", systemImage: "photo.on.rectangle") }
                    Spacer()
                    Button("选择文件") { pickingFile = true }
                }.disabled(store.busy)
                Text("照片会在设备上压缩并去除元数据，核对后再保存。").font(.footnote).foregroundStyle(.secondary)
                if store.existing != nil { Button("移除当前照片", role: .destructive) { removing = true }.disabled(store.busy) }
            }
            if let draft = store.draft {
                Section("待保存预览") {
                    photo(draft.image)
                    Text("\(draft.bytes.count / 1_024) KiB · \(draft.mimeType)").font(.caption).foregroundStyle(.secondary)
                    Button("确认保存这张照片") { saving = true }.buttonStyle(.borderedProminent).disabled(store.busy)
                    Button("生成抠图候选") { Task { await store.startCutout() } }
                        .disabled(store.busy || store.running)
                    Text("生成候选只处理图片，选中并确认保存后才会替换物品照片。").font(.footnote).foregroundStyle(.secondary)
                }
            } else if cutout {
                Section { Text("先选择一张照片，再生成抠图候选。") }
            }
            if let jobID = store.jobID {
                Section("抠图任务") {
                    Text(jobTitle)
                    if store.running { ProgressView() }
                    Button("刷新进度") { Task { await store.refreshJob(); refresh = UUID() } }.disabled(store.busy)
                    if store.running { Button("取消抠图", role: .destructive) { Task { await store.cancelJob() } }.disabled(store.busy) }
                    ForEach(store.job["candidates"].arrayValue ?? [], id: \.candidateIdentity) { candidate in
                        if let id = candidate["id"].stringValue {
                            VStack(alignment: .leading, spacing: 9) {
                                NativeCandidateImage(api: store.api, jobID: jobID, candidateID: id)
                                Button("选择此候选") { Task { await store.chooseCandidate(id) } }.disabled(store.busy)
                            }.padding(.vertical, 6)
                        }
                    }
                }
            }
            if store.busy { ProgressView("正在处理…") }
            if let notice = store.notice { Text(notice).font(.footnote).foregroundStyle(AppTheme.accent) }
            if let error = store.error ?? fileError { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle(cutout ? "物品抠图" : "物品照片")
        .task { await store.load() }
        .task(id: (store.jobID ?? "") + refresh.uuidString) { await store.observe() }
        .onChange(of: selectedPhoto) { _, item in
            guard let item else { return }
            pickingTask?.cancel()
            pickingTask = Task {
                do {
                    if let data = try await item.loadTransferable(type: Data.self) { try Task.checkCancellation(); store.stage(data) }
                } catch { if !Task.isCancelled { fileError = "无法读取所选照片，请重新选择。" } }
            }
        }
        .onDisappear { pickingTask?.cancel(); pickingTask = nil }
        .fileImporter(isPresented: $pickingFile, allowedContentTypes: [.image]) { result in
            do {
                let url = try result.get()
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size > 0, size <= 20 * 1_024 * 1_024 else { throw NativeDataError.invalidFile }
                store.stage(try Data(contentsOf: url))
            } catch { if (error as NSError).code != NSUserCancelledError { fileError = error.localizedDescription } }
        }
        .confirmationDialog("替换物品照片？", isPresented: $saving, titleVisibility: .visible) {
            Button("确认保存") { Task { await store.save() } }
        } message: { Text("只改变当前物品的照片，不会修改购入或售出账单。") }
        .confirmationDialog("移除物品照片？", isPresented: $removing, titleVisibility: .visible) {
            Button("确认移除", role: .destructive) { Task { await store.remove() } }
        }
    }
    private var jobTitle: String {
        switch store.job["state"].stringValue {
        case "queued": return "已排队"
        case "running": return "正在生成候选"
        case "ready": return "候选已就绪"
        case "cancelled": return "已取消"
        case "failed": return "处理未完成，请重新选择照片后显式重试。"
        default: return "正在读取进度"
        }
    }
    private func photo(_ image: UIImage) -> some View {
        Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: 280)
            .background(Color.gray.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
    }
}

private extension JSONValue {
    var candidateIdentity: String { self["id"].stringValue ?? "" }
}

@MainActor private struct NativeCandidateImage: View {
    let api: APIClient
    let jobID: String
    let candidateID: String
    @State private var image: UIImage?
    @State private var error = false
    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 180) }
            else if error { Label("预览暂时无法读取，可重试选择候选。", systemImage: "photo.badge.exclamationmark") }
            else { ProgressView() }
        }
        .task(id: jobID + ":" + candidateID) {
            do {
                let result = try await api.binary("/items/cutouts/" + LedgerURL.segment(jobID) + "/candidates/" +
                    LedgerURL.segment(candidateID) + "/preview", accept: "image/webp", maximumBytes: 2 * 1_024 * 1_024)
                try Task.checkCancellation()
                guard result.mimeType == "image/webp", let value = UIImage(data: result.data) else { throw NativeDataError.invalidResponse }
                image = value
            } catch { if !Task.isCancelled { self.error = true } }
        }
    }
}

@MainActor struct NativePhotoItemChooser: View {
    let api: APIClient
    let cutout: Bool
    @StateObject private var store = LedgerReadListStore<LedgerItem>()
    var body: some View {
        List {
            Text("请选择要管理照片的物品。").font(.footnote).foregroundStyle(.secondary)
            ForEach(store.items) { item in
                NavigationLink(item.name) { NativeItemPhotoView(api: api, itemID: item.id, cutout: cutout) }
            }
            if store.loading { ProgressView() }
            if let error = store.error { Text(error).foregroundStyle(.red) }
            if store.hasMore { Button("加载更多") { Task { await store.next(api: api, path: "/items") } } }
        }.navigationTitle("选择物品")
            .task { await store.reload(api: api, path: "/items", paginated: true, needsMetadata: false) }
    }
}
