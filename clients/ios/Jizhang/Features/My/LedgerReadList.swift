import SwiftUI
import Combine

@MainActor final class LedgerReadListStore<Item: Decodable & Identifiable>: ObservableObject where Item.ID: Hashable {
    @Published private(set) var items: [Item] = []
    @Published private(set) var metadata = LedgerMetadata.empty
    @Published private(set) var total: Int?
    @Published private(set) var loading = false
    @Published private(set) var loadingMore = false
    @Published private(set) var hasLoaded = false
    @Published private(set) var error: String?
    private var generation = 0
    private let pageSize = 50
    var hasMore: Bool { total.map { items.count < $0 } ?? false }

    func reload(api: APIClient, path: String, paginated: Bool, needsMetadata: Bool) async {
        generation += 1
        let ticket = generation
        loading = true
        loadingMore = false
        error = nil
        defer { if generation == ticket { loading = false } }
        do {
            let page: LedgerPage<Item> = try await api.request(paginated ? pagePath(path, offset: 0) : path)
            try validate(page, offset: 0, paginated: paginated)
            let context = needsMetadata ? try await LedgerMetadata.load(api: api) : LedgerMetadata.empty
            guard generation == ticket, !Task.isCancelled else { return }
            items = page.items
            total = paginated ? page.total : page.items.count
            metadata = context
            hasLoaded = true
        } catch {
            guard generation == ticket, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    func next(api: APIClient, path: String) async {
        guard hasMore, !loading, !loadingMore else { return }
        let ticket = generation
        let offset = items.count
        loadingMore = true
        error = nil
        defer { if generation == ticket { loadingMore = false } }
        do {
            let page: LedgerPage<Item> = try await api.request(pagePath(path, offset: offset))
            try validate(page, offset: offset, paginated: true)
            guard generation == ticket, !Task.isCancelled else { return }
            guard page.total == total, !page.items.isEmpty,
                  Set(items.map(\.id)).isDisjoint(with: Set(page.items.map(\.id))) else { throw LedgerDataError.changedPage }
            items.append(contentsOf: page.items)
        } catch {
            guard generation == ticket, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    private func pagePath(_ path: String, offset: Int) -> String {
        LedgerURL.path(path, [("limit", String(pageSize)), ("offset", String(offset))])
    }
    private func validate(_ page: LedgerPage<Item>, offset: Int, paginated: Bool) throws {
        guard Set(page.items.map(\.id)).count == page.items.count else { throw LedgerDataError.invalidResponse }
        if paginated {
            guard page.offset == offset, page.limit == pageSize, let total = page.total,
                  total >= offset, page.items.count <= pageSize, page.items.count <= total - offset else {
                throw LedgerDataError.invalidResponse
            }
        }
    }
}

@MainActor struct LedgerReadList<Item: Decodable & Identifiable, Row: View>: View where Item.ID: Hashable {
    let api: APIClient
    let title: String
    let path: String
    var paginated = false
    var needsMetadata = true
    var footer: String? = nil
    @ViewBuilder let row: (Item, LedgerMetadata) -> Row
    @StateObject private var store = LedgerReadListStore<Item>()

    var body: some View {
        List {
            if store.loading && !store.hasLoaded { LedgerLoadingView() }
            if let error = store.error {
                LedgerErrorView(message: error, showingPrevious: store.hasLoaded) { Task { await load() } }
            }
            if store.hasLoaded && store.items.isEmpty { LedgerEmptyView(title: "暂无" + title) }
            ForEach(store.items) { item in row(item, store.metadata) }
            if paginated && store.hasLoaded {
                Section {
                    if store.hasMore {
                        Button { Task { await store.next(api: api, path: path) } } label: {
                            HStack {
                                Spacer()
                                if store.loadingMore { ProgressView() } else { Text("加载更多") }
                                Spacer()
                            }
                        }.disabled(store.loading || store.loadingMore)
                    }
                    if let total = store.total {
                        Text("已显示 \(store.items.count) / \(total) 条")
                            .font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                    }
                }.listRowBackground(Color.clear)
            }
            if let footer {
                Section { Text(footer).font(.footnote).foregroundStyle(.secondary) }
            }
        }.navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .task { await load() }.refreshable { await load() }
            .onReceive(api.$ledgerRevision.dropFirst()) { _ in Task { await load() } }
    }
    private func load() async {
        await store.reload(api: api, path: path, paginated: paginated, needsMetadata: needsMetadata)
    }
}

/// Inline navigation details retain their selection while refreshing the selected ID.
/// The first presentation uses its already-loaded row, so subscribing adds no initial request.
@MainActor struct LedgerLiveDetail<Item: Decodable & Identifiable, Content: View>: View where Item.ID: Hashable {
    enum Source { case list(String), item(String) }
    struct Snapshot { let item: Item?; let metadata: LedgerMetadata }
    let api: APIClient
    let initial: Item
    let metadata: LedgerMetadata
    let source: Source
    var needsMetadata = true
    @ViewBuilder let content: (Item, LedgerMetadata) -> Content
    @StateObject private var resource = LedgerResource<Snapshot>()

    var body: some View {
        VStack(spacing: 0) {
            if let error = resource.error {
                LedgerErrorView(message: error, showingPrevious: true) { Task { await load() } }
            }
            if let snapshot = resource.value {
                if let item = snapshot.item { content(item, snapshot.metadata) }
                else { LedgerEmptyView(title: "这条记录已不在当前列表", message: "记录可能已删除或处理，请返回列表查看。") }
            } else { content(initial, metadata) }
        }
        .onReceive(api.$ledgerRevision.dropFirst()) { _ in Task { await load() } }
    }

    private func load() async {
        await resource.load {
            let item: Item?
            switch source {
            case .list(let path):
                let page: LedgerPage<Item> = try await api.request(path)
                item = page.items.first { $0.id == initial.id }
                // Trash is capped and advertises its complete total. Absence from a
                // partial response cannot establish deletion; keep the previous detail.
                if item == nil, (page.total.map { $0 > page.items.count } ?? false) ||
                    (page.offset ?? 0) > 0 || page.limit != nil {
                    throw LedgerDataError.changedPage
                }
            case .item(let path):
                do {
                    let value: Item = try await api.request(path)
                    guard value.id == initial.id else { throw LedgerDataError.invalidResponse }
                    item = value
                } catch let error as APIError where error.status == 404 { item = nil }
            }
            let updated = needsMetadata ? try await LedgerMetadata.load(api: api) : metadata
            return Snapshot(item: item, metadata: updated)
        }
    }
}

struct LedgerCatalogRow: View {
    let title: String
    let subtitle: String
    let symbol: String
    var detail: String? = nil
    var body: some View {
        HStack(spacing: 12) {
            LedgerSymbol(name: symbol)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.subheadline.weight(.medium)).foregroundStyle(.primary).lineLimit(2)
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 6)
            if let detail { Text(detail).font(.subheadline.weight(.medium)).monospacedDigit().foregroundStyle(.primary) }
        }.padding(.vertical, 5)
    }
}
