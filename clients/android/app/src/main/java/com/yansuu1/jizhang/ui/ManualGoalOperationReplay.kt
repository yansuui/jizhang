package com.yansuu1.jizhang.ui

import com.yansuu1.jizhang.net.ApiException
import com.yansuu1.jizhang.net.AuthExpiredException
import com.yansuu1.jizhang.repo.FinancialGoalRepository
import com.yansuu1.jizhang.repo.FinancialGoalView
import com.yansuu1.jizhang.repo.FinancialOperationResult
import kotlinx.coroutines.CancellationException
import org.json.JSONObject

/**
 * 校验是否为手动财务目标支持的四种操作路径与 HTTP 方法。
 *
 * 1. PUT    /api/v1/financial-goals/opening
 * 2. POST   /api/v1/financial-goals/entries
 * 3. PATCH  /api/v1/financial-goals/entries/:id
 * 4. DELETE /api/v1/financial-goals/entries/:id
 */
internal fun isSupportedManualGoalPath(method: String, path: String): Boolean {
    val m = method.uppercase()
    return when (m) {
        "PUT" -> path == "/api/v1/financial-goals/opening"
        "POST" -> path == "/api/v1/financial-goals/entries"
        "PATCH", "DELETE" -> path.startsWith("/api/v1/financial-goals/entries/") &&
            path.length > "/api/v1/financial-goals/entries/".length
        else -> false
    }
}

/**
 * 构建手动财务目标的待持久化请求记录。
 * 完整 JSON 包含 operationId 与 expectedRevision，备注等字段通过 JSONObject 统一安全编码。
 */
internal fun buildManualGoalOperation(
    method: String,
    path: String,
    body: JSONObject,
    operationId: String,
    expectedRevision: Long,
): PendingFinancialOperation {
    val upperMethod = method.uppercase()
    require(isSupportedManualGoalPath(upperMethod, path)) {
        "不支持的手动目标操作: $method $path"
    }
    require(operationId.isNotBlank()) { "operationId 不能为空" }
    require(expectedRevision >= 0L) { "expectedRevision 必须为非负整数" }

    // 复制并确保 operationId 与 expectedRevision 写入载荷
    val payload = JSONObject()
    val keys = body.keys()
    while (keys.hasNext()) {
        val key = keys.next()
        payload.put(key, body.get(key))
    }
    payload.put("operationId", operationId)
    payload.put("expectedRevision", expectedRevision)

    return PendingFinancialOperation(
        operationId = operationId,
        method = upperMethod,
        path = path,
        payloadJson = payload.toString(),
        expectedRevision = expectedRevision,
    )
}

/**
 * 验证并规范化待重放的目标操作。
 * 若载荷损坏、缺少 operationId、无法证明原 revision 或路径不受支持，返回 null（只能保留待核对）。
 */
internal fun normalizeOrValidateManualGoalOperation(operation: PendingFinancialOperation): PendingFinancialOperation? {
    if (!isSupportedManualGoalPath(operation.method, operation.path)) return null
    if (operation.operationId.isBlank()) return null
    val json = try {
        JSONObject(operation.payloadJson)
    } catch (_: Exception) {
        return null
    }

    val opId = if (json.has("operationId") && !json.isNull("operationId")) {
        json.getString("operationId")
    } else {
        operation.operationId
    }
    if (opId != operation.operationId) return null

    val rev = if (json.has("expectedRevision") && !json.isNull("expectedRevision")) {
        json.getLong("expectedRevision")
    } else {
        operation.expectedRevision
    }
    if (rev == null || rev < 0L) return null

    // 补齐载荷内的 key 与 revision
    json.put("operationId", opId)
    json.put("expectedRevision", rev)

    return operation.copy(
        operationId = opId,
        expectedRevision = rev,
        payloadJson = json.toString(),
    )
}

/**
 * 判断操作是否为安全带键的手动目标写操作。
 */
internal fun isSafelyKeyedManualGoalOperation(operation: PendingFinancialOperation): Boolean =
    normalizeOrValidateManualGoalOperation(operation) != null

sealed interface ManualGoalMutationOutcome {
    data class Success(val view: FinancialGoalView) : ManualGoalMutationOutcome
    data class DefinitiveFailure(val message: String) : ManualGoalMutationOutcome
    data class Unknown(val message: String) : ManualGoalMutationOutcome
}

data class ManualGoalRecoveryReport(
    val recovered: List<FinancialGoalView> = emptyList(),
    val failures: List<String> = emptyList(),
    val unresolved: List<PendingFinancialOperation> = emptyList(),
)

/** 网关接口：用于生产调用或隔离单元测试。 */
interface ManualGoalMutationGateway {
    suspend fun sendExact(operation: PendingFinancialOperation): FinancialGoalView
    suspend fun lookup(operationId: String): FinancialOperationResult
    suspend fun checkContract(scope: FinancialScope): Boolean = true
}

/** 窄存储接口：供生产委托或测试桩注入。 */
interface ManualGoalPendingOperationStore {
    suspend fun record(scope: FinancialScope, operation: PendingFinancialOperation)
    suspend fun remove(scope: FinancialScope, operationId: String)
    fun list(scope: FinancialScope): List<PendingFinancialOperation>
}

class OperationReplayManualGoalStore(private val store: OperationReplayStore) : ManualGoalPendingOperationStore {
    override suspend fun record(scope: FinancialScope, operation: PendingFinancialOperation) {
        store.record(scope.serverBaseUrl, scope.storageIdentity, operation)
    }

    override suspend fun remove(scope: FinancialScope, operationId: String) {
        store.remove(scope.serverBaseUrl, scope.storageIdentity, operationId)
    }

    override fun list(scope: FinancialScope): List<PendingFinancialOperation> =
        store.list(scope.serverBaseUrl, scope.storageIdentity)
}

class ProductionManualGoalMutationGateway(
    private val repository: FinancialGoalRepository,
) : ManualGoalMutationGateway {
    override suspend fun sendExact(operation: PendingFinancialOperation): FinancialGoalView =
        repository.sendExact(operation)

    override suspend fun lookup(operationId: String): FinancialOperationResult =
        repository.operationResult(operationId)

    override suspend fun checkContract(scope: FinancialScope): Boolean {
        return try {
            val view = repository.load()
            view.contractVersion == 1 && view.source == "manual-confirmed"
        } catch (_: Exception) {
            false
        }
    }
}

/**
 * 手动财务目标（起始值、新增记录、编辑记录、删除记录）的重放与未知结果恢复协调器。
 */
class ManualGoalReplayCoordinator(
    private val gateway: ManualGoalMutationGateway,
    private val store: ManualGoalPendingOperationStore,
    private val scopeProvider: suspend () -> FinancialScope,
) {
    /** 提交新操作：先持久化再发送，未知状态保留本地记录。 */
    suspend fun submit(operation: PendingFinancialOperation): ManualGoalMutationOutcome {
        val scope = try {
            scopeProvider()
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            throw e
        } catch (e: Exception) {
            return ManualGoalMutationOutcome.DefinitiveFailure(
                e.message?.takeIf { it.isNotBlank() } ?: "无法确认登录用户，已阻止请求。",
            )
        }

        val validated = normalizeOrValidateManualGoalOperation(operation)
            ?: return ManualGoalMutationOutcome.DefinitiveFailure("不支持的手动财务目标操作或载荷无效。")

        try {
            store.record(scope, validated)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return ManualGoalMutationOutcome.DefinitiveFailure(
                e.message?.takeIf { it.isNotBlank() } ?: "无法安全记录待执行操作，已阻止请求以防未知网络下丢失幂等依据。",
            )
        }

        val scopeNow = try {
            scopeProvider()
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            throw e
        } catch (e: Exception) {
            return ManualGoalMutationOutcome.Unknown("登录状态在保存前发生变化，操作结果未知，请重新登录后核对。")
        }
        if (!scopeNow.sameIdentity(scope)) {
            return ManualGoalMutationOutcome.Unknown("登录用户或服务端地址在保存前发生变化，已阻止发送；请切回原账号后重试。")
        }

        return send(scopeNow, validated, alreadyPersisted = true)
    }

    /** 重试已知未决操作：使用原 operationId、载荷与 expectedRevision，不接受篡改。 */
    suspend fun retry(operation: PendingFinancialOperation): ManualGoalMutationOutcome {
        val scope = try {
            scopeProvider()
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            throw e
        } catch (e: Exception) {
            return ManualGoalMutationOutcome.Unknown("无法确认登录用户，操作结果仍未知。")
        }

        val validated = normalizeOrValidateManualGoalOperation(operation)
            ?: return ManualGoalMutationOutcome.Unknown("待重放操作缺少一致的键或修订号，已阻止自动重发以防冲突。")

        return send(scope, validated, alreadyPersisted = true)
    }

    /**
     * 进程重启或页面恢复时核对未决结果：
     * 1. 查询服务端 operationResult；
     * 2. 若查到已提交结果，先核对 operation 身份，按 response 恢复并清理本地 pending；
     * 3. 若服务端返回 404，仅在当前作用域明确支持重放合同（contractVersion=1 且 source=manual-confirmed）时才原键重发；
     * 4. 若为确定性 400/409，清理本地并记入 failures；
     * 5. 若网络中断或 5xx，保留在 unresolved；
     * 6. 本机清理失败不将已提交业务报为失败。
     */
    suspend fun recover(): ManualGoalRecoveryReport {
        val scope = try {
            scopeProvider()
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            throw e
        } catch (e: Exception) {
            return ManualGoalRecoveryReport(failures = listOf("无法确认登录用户，未能恢复待核对操作。"))
        }

        val pending = store.list(scope).filter {
            isSupportedManualGoalPath(it.method, it.path)
        }.sortedBy { it.createdAt }

        if (pending.isEmpty()) return ManualGoalRecoveryReport()

        val recovered = mutableListOf<FinancialGoalView>()
        val failures = mutableListOf<String>()
        val unresolved = mutableListOf<PendingFinancialOperation>()

        for (operation in pending) {
            val validated = normalizeOrValidateManualGoalOperation(operation)
            if (validated == null) {
                unresolved.add(operation)
                continue
            }

            var shouldReplay = false
            val lookup = try {
                gateway.lookup(operation.operationId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: AuthExpiredException) {
                throw e
            } catch (e: ApiException) {
                if (e.status == 404) {
                    val supported = try {
                        gateway.checkContract(scope)
                    } catch (_: Exception) {
                        false
                    }
                    if (supported) {
                        shouldReplay = true
                    } else {
                        unresolved.add(operation)
                    }
                    null
                } else {
                    when (val failure = classifyFinancialWriteFailure(e)) {
                        is FinancialWriteFailure.Rejected -> {
                            removeBestEffort(scope, operation.operationId)
                            failures.add(failure.message)
                            null
                        }
                        else -> {
                            unresolved.add(operation)
                            null
                        }
                    }
                }
            } catch (e: Exception) {
                unresolved.add(operation)
                null
            }

            if (lookup != null) {
                val matchesIdentity = lookup.operationId == operation.operationId &&
                    lookup.method.equals(operation.method, ignoreCase = true)
                if (matchesIdentity) {
                    removeBestEffort(scope, operation.operationId)
                    val view = try {
                        FinancialGoalView.fromJson(lookup.response)
                    } catch (_: Exception) {
                        null
                    }
                    if (view != null) {
                        recovered.add(view)
                    } else {
                        unresolved.add(operation)
                    }
                } else {
                    unresolved.add(operation)
                }
                continue
            }

            if (!shouldReplay) continue

            when (val outcome = send(scope, validated, alreadyPersisted = true)) {
                is ManualGoalMutationOutcome.Success -> recovered.add(outcome.view)
                is ManualGoalMutationOutcome.DefinitiveFailure -> failures.add(outcome.message)
                is ManualGoalMutationOutcome.Unknown -> unresolved.add(operation)
            }
        }

        return ManualGoalRecoveryReport(
            recovered = recovered,
            failures = failures,
            unresolved = unresolved,
        )
    }

    private suspend fun send(
        scope: FinancialScope,
        operation: PendingFinancialOperation,
        alreadyPersisted: Boolean,
    ): ManualGoalMutationOutcome {
        check(alreadyPersisted)
        return try {
            val view = gateway.sendExact(operation)
            removeBestEffort(scope, operation.operationId)
            ManualGoalMutationOutcome.Success(view)
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            throw e
        } catch (e: Exception) {
            when (val failure = classifyFinancialWriteFailure(e)) {
                is FinancialWriteFailure.Rejected -> {
                    removeBestEffort(scope, operation.operationId)
                    ManualGoalMutationOutcome.DefinitiveFailure(failure.message)
                }
                is FinancialWriteFailure.Unknown -> ManualGoalMutationOutcome.Unknown(failure.message)
                FinancialWriteFailure.AuthExpired -> throw AuthExpiredException()
            }
        }
    }

    private suspend fun removeBestEffort(scope: FinancialScope, operationId: String) {
        runCatching { store.remove(scope, operationId) }
    }
}
