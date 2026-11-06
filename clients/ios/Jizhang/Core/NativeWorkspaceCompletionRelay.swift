import Combine
import Foundation

/// Keeps a successful native receipt local until the workspace has actually dismissed.
@MainActor final class NativeWorkspaceCompletionRelay: ObservableObject {
    let ownerIdentity: UUID
    private var pending: NativeWorkspaceCompletion?
    private var emittedRequests = Set<String>()

    init(ownerIdentity: UUID) { self.ownerIdentity = ownerIdentity }
    var hasPending: Bool { pending != nil }

    @discardableResult
    func store(_ completion: NativeWorkspaceCompletion, currentOwner: UUID?) -> Bool {
        guard currentOwner == ownerIdentity else { clear(); return false }
        guard completion.apiIdentity == ownerIdentity,
              !emittedRequests.contains(completion.clientRequestID) else { return false }
        if let pending {
            guard pending.conversationID == completion.conversationID,
                  pending.sourceMessageID == completion.sourceMessageID else { return false }
            if pending.clientRequestID == completion.clientRequestID { return true }
        }
        pending = completion
        return true
    }

    func takeAfterDismiss(currentOwner: UUID?) -> NativeWorkspaceCompletion? {
        guard currentOwner == ownerIdentity else { clear(); return nil }
        guard let completion = pending else { return nil }
        pending = nil
        guard emittedRequests.insert(completion.clientRequestID).inserted else { return nil }
        return completion
    }

    func clear() { pending = nil }
}
