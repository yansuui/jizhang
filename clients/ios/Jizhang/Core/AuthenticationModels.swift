import Foundation

struct AuthenticatedUser: Decodable, Equatable {
    let id: String?
    let username: String
    let role: String?
    let capabilities: [String]
    let expiresAt: Int64

    var canManageInvitations: Bool {
        id != nil && role == "admin" && capabilities.contains("manageInvitations")
    }

    private enum CodingKeys: String, CodingKey { case id, username, role, capabilities, expiresAt }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(String.self, forKey: .id)
        username = try values.decode(String.self, forKey: .username)
        role = try values.decodeIfPresent(String.self, forKey: .role)
        capabilities = try values.decodeIfPresent([String].self, forKey: .capabilities) ?? []
        expiresAt = try values.decode(Int64.self, forKey: .expiresAt)
        guard !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              id.map({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) ?? true,
              expiresAt > 0 else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath,
                                                     debugDescription: "Invalid authenticated identity"))
        }
    }
}

struct RegistrationDraft {
    var username = ""
    var password = ""
    var confirmation = ""
    var invitationCode = ""

    func payload() throws -> JSONValue {
        let account = username.trimmingCharacters(in: .whitespacesAndNewlines)
        let code = invitationCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard account.range(of: "^[A-Za-z0-9_.-]{3,64}$", options: .regularExpression) != nil else {
            throw APIError(status: 0, code: "VALIDATION", message: "账号需为 3–64 位英文字母、数字、点、下划线或短横线。")
        }
        // Server validation counts UTF-16 units (JavaScript String.length).
        guard (8...128).contains(password.utf16.count) else {
            throw APIError(status: 0, code: "WEAK_PASSWORD", message: "密码需为 8–128 位。")
        }
        guard password == confirmation else {
            throw APIError(status: 0, code: "VALIDATION", message: "两次输入的密码不一致。")
        }
        guard !code.isEmpty, code.utf16.count <= 256 else {
            throw APIError(status: 0, code: "INVALID_INVITATION", message: "请输入有效的邀请码。")
        }
        return .object(["username": .string(account), "password": .string(password), "invitationCode": .string(code)])
    }
}
