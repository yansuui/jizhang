import Combine
import Foundation

@MainActor
final class InvitationStore: ObservableObject {
    enum Operation { case load, create, revoke }
    @Published private(set) var invitations: [Invitation] = []
    @Published private(set) var created: CreatedInvitation?
    @Published private(set) var operation: Operation?
    @Published private(set) var error: String?
    @Published private(set) var hasLoaded = false
    @Published private(set) var permissionDenied = false

    private let api: APIClient
    private let authorized: Bool
    private var ticket = UUID()

    init(api: APIClient, user: AuthenticatedUser) {
        self.api = api
        authorized = user.canManageInvitations
        permissionDenied = !authorized
    }

    var busy: Bool { operation != nil }
    var canManage: Bool { authorized && !permissionDenied }

    func load() async {
        guard canManage, !busy else { return }
        let current = begin(.load)
        defer { finish(current) }
        do {
            let result: InvitationList = try await api.request("/admin/invitations")
            guard owns(current) else { return }
            guard Set(result.invitations.map(\.id)).count == result.invitations.count,
                  result.invitations.allSatisfy({ !$0.id.isEmpty && $0.expiresAt >= $0.createdAt }) else {
                throw APIError.invalidResponse
            }
            invitations = result.invitations
            hasLoaded = true
        } catch { failed(error, ticket: current) }
    }

    func create() async {
        guard canManage, !busy, created == nil else { return }
        let current = begin(.create)
        defer { finish(current) }
        do {
            let result: CreatedInvitation = try await api.request("/admin/invitations", method: "POST", body: .object([:]))
            guard owns(current) else { return }
            guard !result.code.isEmpty, result.code.count <= 256, !result.invitation.id.isEmpty else {
                throw APIError.invalidResponse
            }
            created = result
            invitations.removeAll { $0.id == result.invitation.id }
            invitations.insert(result.invitation, at: 0)
        } catch {
            failed(error, ticket: current)
            let status = (error as? APIError)?.status ?? 0
            if owns(current), !permissionDenied, !(error is CancellationError),
               status == 0 || status >= 500 {
                self.error = "未能确认创建结果。请刷新列表；如已创建，可撤销后重新生成。"
            }
        }
    }

    func revoke(_ invitation: Invitation) async {
        guard canManage, !busy, invitation.currentStatus() == .active else { return }
        let current = begin(.revoke)
        defer { finish(current) }
        do {
            let result: InvitationMutationResult = try await api.request(try invitation.revokePath, method: "DELETE")
            guard owns(current) else { return }
            guard result.ok else { throw APIError.invalidResponse }
            if let index = invitations.firstIndex(where: { $0.id == invitation.id }) {
                invitations[index] = Invitation(id: invitation.id, createdAt: invitation.createdAt,
                    expiresAt: invitation.expiresAt, status: .revoked, usedAt: invitation.usedAt)
            }
            if created?.invitation.id == invitation.id { created = nil }
        } catch { failed(error, ticket: current) }
    }

    func dismissCode() { created = nil }

    /// Leaving the screen discards the one-time secret and rejects pending UI updates.
    func leave() {
        ticket = UUID()
        created = nil
        operation = nil
    }

    private func begin(_ operation: Operation) -> UUID {
        ticket = UUID()
        self.operation = operation
        error = nil
        return ticket
    }

    private func finish(_ current: UUID) {
        if ticket == current { operation = nil }
    }

    private func owns(_ current: UUID) -> Bool { ticket == current && !Task.isCancelled }

    private func failed(_ failure: Error, ticket current: UUID) {
        guard owns(current), !(failure is CancellationError) else { return }
        if (failure as? APIError)?.status == 403 {
            permissionDenied = true
            created = nil
            invitations = []
        }
        error = failure.localizedDescription
    }
}
