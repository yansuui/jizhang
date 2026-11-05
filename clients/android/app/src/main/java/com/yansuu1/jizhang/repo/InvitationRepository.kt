package com.yansuu1.jizhang.repo

import com.yansuu1.jizhang.net.ApiClient
import org.json.JSONObject
import java.net.URLEncoder

data class Invitation(
    val id: String,
    val createdAt: Long,
    val expiresAt: Long,
    val status: String,
    val usedAt: Long?,
) {
    fun currentStatus(now: Long = System.currentTimeMillis()): String =
        if (status == "active" && expiresAt <= now) "expired" else status

    fun revokePath(): String {
        require(id.isNotEmpty() && id != "." && id != "..") { "邀请码标识无效" }
        return "/api/v1/admin/invitations/" + URLEncoder.encode(id, "UTF-8").replace("+", "%20")
    }

    companion object {
        fun fromJson(json: JSONObject): Invitation {
            val id = json.getString("id")
            val created = json.getLong("createdAt")
            val expires = json.getLong("expiresAt")
            val status = json.getString("status")
            require(id.isNotBlank() && expires >= created && status in setOf("active", "used", "expired", "revoked")) {
                "邀请码响应无效，请刷新重试"
            }
            return Invitation(id, created, expires, status, if (json.isNull("usedAt")) null else json.getLong("usedAt"))
        }
    }
}

data class CreatedInvitation(val invitation: Invitation, val code: String)

class InvitationRepository(private val api: ApiClient) {
    suspend fun list(): List<Invitation> {
        val array = api.get("/api/v1/admin/invitations").getJSONArray("invitations")
        val items = (0 until array.length()).map { Invitation.fromJson(array.getJSONObject(it)) }
        require(items.map { it.id }.distinct().size == items.size) { "邀请码列表重复，请刷新重试" }
        return items
    }

    suspend fun create(): CreatedInvitation {
        val json = api.post("/api/v1/admin/invitations", JSONObject())
        val code = json.getString("code")
        require(code.isNotBlank() && code.length <= 256) { "未收到有效邀请码，请刷新列表后重试" }
        return CreatedInvitation(Invitation.fromJson(json.getJSONObject("invitation")), code)
    }

    suspend fun revoke(invitation: Invitation) {
        require(api.delete(invitation.revokePath()).getBoolean("ok")) { "撤销未完成，请刷新重试" }
    }
}
