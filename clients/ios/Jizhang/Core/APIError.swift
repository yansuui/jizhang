import Foundation

struct APIError: Error, LocalizedError, Equatable {
    let status: Int
    let code: String
    let message: String

    var errorDescription: String? { message }

    static let invalidAddress = APIError(status: 0, code: "INVALID_ADDRESS", message: "请填写完整的 HTTPS 服务器地址，不含路径、账号或查询参数。")
    static let invalidPath = APIError(status: 0, code: "INVALID_PATH", message: "请求地址无效。请重试或更新应用。")
    static let invalidResponse = APIError(status: 0, code: "INVALID_RESPONSE", message: "服务器返回的数据无法读取，请检查服务器版本后重试。")
    static let sessionMissing = APIError(status: 401, code: "SESSION_MISSING", message: "未收到有效的登录会话，请检查服务器连接设置。")
    static let unauthorized = APIError(status: 401, code: "UNAUTHORIZED", message: "登录已过期，请重新登录。")
    static let credentialStorage = APIError(status: 0, code: "CREDENTIAL_STORAGE", message: "无法访问设备的安全存储。请解锁设备后重试。")

    /// Only known codes become UI copy. Arbitrary server/provider bodies are not exposed.
    static func response(status: Int, data: Data) -> APIError {
        let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
        let receivedCode = envelope?.error.code ?? ""
        let allowedCode = !receivedCode.isEmpty && receivedCode.count <= 80
            && receivedCode.unicodeScalars.allSatisfy { (65...90).contains($0.value) || (48...57).contains($0.value) || $0.value == 95 }
        let code = allowedCode ? receivedCode : "HTTP_\(status)"
        let message: String
        switch code {
        case "INVALID_CREDENTIALS": message = "账号或密码不正确。"
        case "INVALID_INVITATION": message = "邀请码无效、已使用或已过期，请向管理员获取新的邀请码。"
        case "INVITATION_USED": message = "这个邀请码已被使用，请刷新列表查看最新状态。"
        case "USERNAME_TAKEN": message = "这个账号已被使用，请更换账号。如果刚才已完成注册，请返回登录。"
        case "WEAK_PASSWORD": message = "密码需为 8–128 位，请修改后重试。"
        case "RATE_LIMITED": message = "尝试过于频繁，请稍后再试。"
        case "FORBIDDEN": message = "当前账号没有管理邀请码的权限。"
        case "UNAUTHORIZED": message = "登录已过期，请重新登录。"
        case "CSRF_REQUIRED": message = "请求验证失败，请重新登录后重试。"
        case "AI_NOT_CONFIGURED": message = "请先配置并启用 AI 助手。"
        case "AI_ENCRYPTION_KEY_REQUIRED": message = "服务器尚未设置 AI 密钥加密配置，请联系服务维护者。"
        case "AI_SECRET_UNAVAILABLE": message = "服务器无法读取已保存的 AI 密钥，请重新配置密钥。"
        case "AI_CONFIG_INVALID": message = "AI 配置不完整或格式不正确，请检查地址、模型和高级设置。"
        case "AI_PROVIDER_TIMEOUT": message = "AI 服务响应超时，请稍后重试。"
        case "AI_PROVIDER_ERROR": message = "暂时无法连接 AI 服务，请检查接口配置后重试。"
        case "AI_RESPONSE_INVALID": message = "AI 服务返回的内容不符合要求，请检查模型与协议设置。"
        case "ASSISTANT_GENERATION_ACTIVE": message = "当前对话仍在生成回复，请等待或停止后再发送。"
        case "ASSISTANT_REQUEST_CONFLICT": message = "发送内容与原请求不一致，请刷新对话后核对。"
        case "ASSISTANT_CHOICE_STALE": message = "这条追问已更新，请刷新对话后重新选择。"
        case "ASSISTANT_REPLAY_UNAVAILABLE": message = "需要重新核对这条回复的当前状态。"
        case "ASSISTANT_NOT_FOUND", "NOT_FOUND": message = "内容不存在，或服务器暂不支持此功能。"
        case "VALIDATION", "AI_INPUT_INVALID", "ASSISTANT_GENERATION_INVALID": message = "提交的内容不符合要求，请检查后重试。"
        default:
            switch status {
            case 401: message = "登录已过期，请重新登录。"
            case 403: message = "暂时无法执行此操作，请检查登录状态。"
            case 404: message = "服务器暂不支持此功能，或内容已不存在。"
            case 409: message = "内容状态已变化，请刷新后核对。"
            case 413: message = "提交的内容太大，请缩短后重试。"
            case 429: message = "请求过于频繁，请稍后重试。"
            case 300..<400: message = "服务器返回了重定向，请填写最终的 HTTPS 服务器地址。"
            case 500...599: message = "服务器暂时不可用，请稍后重试。"
            default: message = "请求未能完成，请稍后重试。"
            }
        }
        return APIError(status: status, code: code, message: message)
    }

    static func transport(_ error: Error) -> Error {
        if error is CancellationError { return error }
        if let apiError = error as? APIError { return apiError }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cancelled: return CancellationError()
            case .notConnectedToInternet, .networkConnectionLost:
                return APIError(status: 0, code: "OFFLINE", message: "网络连接已断开，请联网后重试。")
            case .timedOut:
                return APIError(status: 0, code: "TIMEOUT", message: "连接超时，请检查网络后重试。")
            case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot:
                return APIError(status: 0, code: "TLS_ERROR", message: "无法建立安全连接，请检查服务器 HTTPS 证书。")
            default:
                return APIError(status: 0, code: "CONNECTION_FAILED", message: "无法连接服务器，请检查地址和网络。")
            }
        }
        if error is DecodingError { return APIError.invalidResponse }
        return APIError(status: 0, code: "REQUEST_FAILED", message: "请求未完成，请稍后重试。")
    }

    private struct ErrorEnvelope: Decodable {
        let error: Details
        struct Details: Decodable { let code: String }
    }
}
