import Foundation

struct Invitation: Decodable, Identifiable, Equatable {
    let id: String
    let createdAt: Int64
    let expiresAt: Int64
    let status: Status
    let usedAt: Int64?

    enum Status: String, Decodable {
        case active, used, expired, revoked
        var title: String {
            switch self {
            case .active: return "待使用"
            case .used: return "已使用"
            case .expired: return "已过期"
            case .revoked: return "已撤销"
            }
        }
    }

    var expiryDate: Date { Date(timeIntervalSince1970: Double(expiresAt) / 1_000) }

    func currentStatus(now: Date = Date()) -> Status {
        status == .active && expiryDate <= now ? .expired : status
    }

    var revokePath: String {
        get throws {
            guard !id.isEmpty, id != ".", id != "..",
                  let component = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_"))) else {
                throw APIError.invalidResponse
            }
            return "/admin/invitations/\(component)"
        }
    }
}

struct InvitationList: Decodable { let invitations: [Invitation] }
struct CreatedInvitation: Decodable { let invitation: Invitation; let code: String }

struct InvitationMutationResult: Decodable { let ok: Bool }
