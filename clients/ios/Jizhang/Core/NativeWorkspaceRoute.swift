import SwiftUI

/// Trusted app destinations. Model-provided paths or URLs are never executed.
enum NativeWorkspaceDestination: String, CaseIterable, Codable {
    case providerSettings = "provider-settings"
    case invitations, password
    case dataImport = "data-import"
    case platformImport = "platform-import"
    case dataExport = "data-export"
    case itemPhoto = "item-photo"
    case itemCutout = "item-cutout"
    case reminders, logout
    case serverSwitch = "server-switch"
}

struct NativeWorkspaceRoute: Identifiable, Equatable {
    let destination: NativeWorkspaceDestination
    let itemID: String?
    let conversationID: String?
    let batchID: String?
    var id: String { [destination.rawValue, itemID ?? "", conversationID ?? "", batchID ?? ""].joined(separator: ":") }

    init(destination: NativeWorkspaceDestination, itemID: String? = nil, conversationID: String? = nil, batchID: String? = nil) {
        self.destination = destination; self.itemID = itemID
        self.conversationID = conversationID; self.batchID = batchID
    }

    init?(value: JSONValue) {
        guard let name = value["destination"].stringValue,
              let destination = NativeWorkspaceDestination(rawValue: name) else { return nil }
        let item = value["itemId"].stringValue
        if let item, item.isEmpty || item.utf8.count > 200 { return nil }
        let conversation = value["conversationId"].stringValue
        let batch = value["batchId"].stringValue
        if [conversation, batch].compactMap({ $0 }).contains(where: { $0.isEmpty || $0.utf8.count > 200 }) { return nil }
        self.init(destination: destination, itemID: item, conversationID: conversation, batchID: batch)
    }
}

private struct NativeWorkspaceOpenKey: EnvironmentKey {
    static let defaultValue: ((NativeWorkspaceRoute) -> Void)? = nil
}
private struct NativeInvitationPermissionKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var jizhangCanManageInvitations: Bool {
        get { self[NativeInvitationPermissionKey.self] }
        set { self[NativeInvitationPermissionKey.self] = newValue }
    }
    var openJizhangWorkspace: ((NativeWorkspaceRoute) -> Void)? {
        get { self[NativeWorkspaceOpenKey.self] }
        set { self[NativeWorkspaceOpenKey.self] = newValue }
    }
}
