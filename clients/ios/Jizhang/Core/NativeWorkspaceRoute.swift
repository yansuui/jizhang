import SwiftUI
import CryptoKit

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
    let sourceMessageID: String?
    var id: String { [destination.rawValue, itemID ?? "", conversationID ?? "", batchID ?? "", sourceMessageID ?? ""].joined(separator: ":") }

    init(destination: NativeWorkspaceDestination, itemID: String? = nil, conversationID: String? = nil, batchID: String? = nil,
         sourceMessageID: String? = nil) {
        self.destination = destination; self.itemID = itemID
        self.conversationID = conversationID; self.batchID = batchID
        self.sourceMessageID = sourceMessageID
    }

    init?(value: JSONValue) {
        guard let name = value["destination"].stringValue,
              let destination = NativeWorkspaceDestination(rawValue: name) else { return nil }
        let item = value["itemId"].stringValue
        if let item, item.isEmpty || item.utf8.count > 200 { return nil }
        let conversation = value["conversationId"].stringValue
        let batch = value["batchId"].stringValue
        let message = value["sourceMessageId"].stringValue
        if [conversation, batch, message].compactMap({ $0 }).contains(where: { $0.isEmpty || $0.utf8.count > 200 }) { return nil }
        self.init(destination: destination, itemID: item, conversationID: conversation, batchID: batch, sourceMessageID: message)
    }
}

private struct NativeWorkspaceOpenKey: EnvironmentKey {
    static let defaultValue: ((NativeWorkspaceRoute) -> Void)? = nil
}
private struct NativeInvitationPermissionKey: EnvironmentKey {
    static let defaultValue = false
}
private struct NativeWorkspaceResultKey: EnvironmentKey {
    static let defaultValue: ((JSONValue) -> Void)? = nil
}

extension EnvironmentValues {
    var recordJizhangNativeResult: ((JSONValue) -> Void)? {
        get { self[NativeWorkspaceResultKey.self] }
        set { self[NativeWorkspaceResultKey.self] = newValue }
    }
    var jizhangCanManageInvitations: Bool {
        get { self[NativeInvitationPermissionKey.self] }
        set { self[NativeInvitationPermissionKey.self] = newValue }
    }
    var openJizhangWorkspace: ((NativeWorkspaceRoute) -> Void)? {
        get { self[NativeWorkspaceOpenKey.self] }
        set { self[NativeWorkspaceOpenKey.self] = newValue }
    }
}

struct NativeWorkspaceCompletion: Equatable, Sendable {
    let apiIdentity: UUID
    let conversationID: String
    let sourceMessageID: String
    let reference: JSONValue
    let clientRequestID: String
    var body: JSONValue { .object(["clientRequestId": .string(clientRequestID),
                                  "sourceMessageId": .string(sourceMessageID), "reference": reference]) }
    init?(apiIdentity: UUID, route: NativeWorkspaceRoute, reference: JSONValue) {
        guard let conversation = route.conversationID, !conversation.isEmpty,
              let message = route.sourceMessageID, !message.isEmpty,
              ["csv-import", "platform-import", "item-photo", "export"].contains(reference["kind"].stringValue ?? "")
        else { return nil }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(reference) else { return nil }
        var identity = Data((conversation + ":" + message + ":").utf8); identity.append(data)
        self.apiIdentity = apiIdentity; conversationID = conversation; sourceMessageID = message
        self.reference = reference
        clientRequestID = "native-" + SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
    }
}

extension Notification.Name {
    static let jizhangNativeWorkspaceCompleted = Notification.Name("jizhang.native-workspace.completed.v1")
}
