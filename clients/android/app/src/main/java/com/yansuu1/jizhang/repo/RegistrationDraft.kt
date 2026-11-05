package com.yansuu1.jizhang.repo

import org.json.JSONObject

data class RegistrationDraft(
    val username: String,
    val password: String,
    val confirmation: String,
    val invitationCode: String,
) {
    fun toBody(): JSONObject {
        val account = username.trim()
        val code = invitationCode.trim()
        require(Regex("^[A-Za-z0-9_.-]{3,64}$").matches(account)) {
            "账号需为 3–64 位英文字母、数字、点、下划线或短横线。"
        }
        require(password.length in 8..128) { "密码需为 8–128 位。" }
        require(password == confirmation) { "两次输入的密码不一致。" }
        require(code.isNotEmpty() && code.length <= 256) { "请输入有效的邀请码。" }
        return JSONObject().put("username", account).put("password", password).put("invitationCode", code)
    }
}
