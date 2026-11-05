package com.yansuu1.jizhang.net

import org.json.JSONObject

data class AuthenticatedUser(
    val id: String?,
    val username: String,
    val role: String?,
    val capabilities: Set<String>,
    val expiresAt: Long,
) {
    val canManageInvitations: Boolean
        get() = id != null && role == "admin" && "manageInvitations" in capabilities

    companion object {
        fun fromJson(json: JSONObject, requireStableId: Boolean = false): AuthenticatedUser {
            val username = json.opt("username") as? String
            val id = if (json.isNull("id")) null else json.opt("id") as? String
            require(!username.isNullOrBlank()) { "认证响应缺少有效账号" }
            require(!json.has("id") || json.isNull("id") || !id.isNullOrBlank()) { "认证响应缺少有效用户标识" }
            require(!requireStableId || !id.isNullOrBlank()) { "注册响应缺少用户标识，请返回登录页重试" }
            val capabilities = json.optJSONArray("capabilities")?.let { array ->
                (0 until array.length()).map { array.getString(it) }.toSet()
            } ?: emptySet()
            val expiry = json.getLong("expiresAt")
            require(expiry > System.currentTimeMillis()) { "登录会话已过期，请重新登录" }
            return AuthenticatedUser(id, username, json.optString("role").takeIf { it.isNotEmpty() }, capabilities, expiry)
        }
    }
}

internal fun isPublicAuthenticationPath(path: String): Boolean =
    path == "/api/v1/auth/login" || path == "/api/v1/auth/register"

fun authenticationErrorMessage(error: Exception): String = when ((error as? ApiException)?.code) {
    "INVALID_INVITATION" -> "邀请码无效、已使用或已过期，请向管理员获取新的邀请码。"
    "USERNAME_TAKEN" -> "这个账号已被使用。若刚才注册时网络中断，可返回登录页尝试登录。"
    "INVALID_CREDENTIALS", "UNAUTHORIZED" -> "账号或密码不正确。"
    "WEAK_PASSWORD" -> "密码需为 8–128 位。"
    "RATE_LIMITED" -> "尝试过于频繁，请稍后重试。"
    "FORBIDDEN" -> "当前账号没有管理邀请码的权限。"
    "INVITATION_USED" -> "邀请码已被使用，请刷新列表查看最新状态。"
    "NOT_FOUND" -> "服务器暂不支持此功能，请联系管理员升级服务。"
    else -> error.message ?: "请求失败，请稍后重试。"
}
