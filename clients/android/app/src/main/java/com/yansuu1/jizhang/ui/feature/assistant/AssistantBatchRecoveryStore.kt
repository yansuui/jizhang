package com.yansuu1.jizhang.ui.feature.assistant

import android.content.Context
import com.yansuu1.jizhang.ui.FinancialScope
import org.json.JSONArray
import org.json.JSONObject

/**
 * 导入批次操作持久化接口。
 * 严禁持久化原始文件字节、reviewToken 或聊天对话内容。
 */
interface AssistantBatchRecoveryStore {
    suspend fun record(scope: FinancialScope, metadata: BatchMutationMetadata)
    fun list(scope: FinancialScope, conversationId: String, batchId: String): List<BatchMutationMetadata>
    suspend fun remove(scope: FinancialScope, metadata: BatchMutationMetadata)
}

class SharedPreferencesAssistantBatchRecoveryStore(context: Context) : AssistantBatchRecoveryStore {
    private val prefs = context.getSharedPreferences("batch_mutation_recovery", Context.MODE_PRIVATE)
    private val lock = Any()

    fun hasLegacyRecords(serverBaseUrl: String, username: String): Boolean = synchronized(lock) {
        prefs.all.keys.any { it.startsWith("$serverBaseUrl|$username|") }
    }

    private fun storageKey(scope: FinancialScope, conversationId: String, batchId: String): String {
        val version = if (scope.userId != null) "v2|" else ""
        return "$version${scope.serverBaseUrl}|${scope.storageIdentity}|$conversationId|$batchId"
    }

    override suspend fun record(scope: FinancialScope, metadata: BatchMutationMetadata) {
        synchronized(lock) {
            val key = storageKey(scope, metadata.conversationId, metadata.batchId)
            val existing = listInternal(key).toMutableList()
            // Replace or add by clientRequestId so a retry never stores two rows.
            existing.removeAll { it.clientRequestId == metadata.clientRequestId }
            existing.add(metadata)
            saveInternal(key, existing)
        }
    }

    override fun list(scope: FinancialScope, conversationId: String, batchId: String): List<BatchMutationMetadata> {
        synchronized(lock) {
            return listInternal(storageKey(scope, conversationId, batchId))
        }
    }

    override suspend fun remove(scope: FinancialScope, metadata: BatchMutationMetadata) {
        synchronized(lock) {
            val key = storageKey(scope, metadata.conversationId, metadata.batchId)
            val existing = listInternal(key).toMutableList()
            val removed = existing.removeAll { it.clientRequestId == metadata.clientRequestId }
            if (removed) {
                saveInternal(key, existing)
            }
        }
    }

    private fun listInternal(key: String): List<BatchMutationMetadata> {
        val jsonStr = prefs.getString(key, null) ?: return emptyList()
        return try {
            val arr = JSONArray(jsonStr)
            (0 until arr.length()).mapNotNull { idx ->
                arr.optJSONObject(idx)?.let { BatchMutationMetadata.fromJson(it) }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun saveInternal(key: String, list: List<BatchMutationMetadata>) {
        if (list.isEmpty()) {
            prefs.edit().remove(key).apply()
        } else {
            val arr = JSONArray()
            list.forEach { arr.put(it.toJson()) }
            prefs.edit().putString(key, arr.toString()).apply()
        }
    }
}
