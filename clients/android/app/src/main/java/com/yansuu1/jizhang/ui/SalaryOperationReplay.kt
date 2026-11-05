package com.yansuu1.jizhang.ui

import com.yansuu1.jizhang.net.ApiException
import com.yansuu1.jizhang.net.AuthExpiredException
import com.yansuu1.jizhang.repo.FinancialOperationResult
import kotlinx.coroutines.CancellationException
import org.json.JSONObject

/** One immutable salary-create request; the operationId never changes on retry. */
data class SalaryCreateRequest(
    val operationId: String,
    val payloadJson: String,
) {
    init {
        require(operationId.isNotBlank()) { "operationId 不能为空" }
        require(payloadJson.isNotBlank()) { "payloadJson 不能为空" }
        // Fail before anything is persisted if the payload is not an object.
        JSONObject(payloadJson)
    }

    companion object {
        const val PATH = "/api/v1/salaries"
        const val METHOD = "POST"

        fun build(input: Map<String, Any?>, operationId: String): SalaryCreateRequest {
            val payload = JSONObject()
            input.forEach { (key, value) -> payload.put(key, value) }
            payload.put("operationId", operationId)
            return SalaryCreateRequest(operationId, payload.toString())
        }
    }
}

/**
 * Validates that a pending salary operation has matching operationId inside its payload.
 * Only POST /api/v1/salaries with valid JSON containing the exact operationId is safely keyed.
 */
internal fun isSafelyKeyedSalaryOperation(operation: PendingFinancialOperation): Boolean {
    if (operation.method != SalaryCreateRequest.METHOD || operation.path != SalaryCreateRequest.PATH) {
        return false
    }
    if (operation.operationId.isBlank()) return false
    return try {
        val json = JSONObject(operation.payloadJson)
        json.optString("operationId") == operation.operationId
    } catch (_: Exception) {
        false
    }
}

/**
 * Salary creation is write-safe only when the server supports the operationId contract.
 * An old/unsupported server cannot safely retry a lost response, so fail closed instead
 * of silently falling back to an unkeyed duplicate-prone POST.
 */
internal fun salaryCreateCapabilityError(supported: Boolean?): String? = when (supported) {
    true -> null
    false -> "当前服务端不支持工资幂等保存，已阻止新增工资；请升级服务端后重试。"
    null -> "暂时无法确认工资安全重放能力，已阻止新增工资；请稍后重试。"
}

sealed interface SalaryMutationOutcome {
    data class Success(val salary: JSONObject) : SalaryMutationOutcome
    data class DefinitiveFailure(val message: String) : SalaryMutationOutcome
    data class Unknown(val message: String) : SalaryMutationOutcome
}

data class SalaryRecoveryReport(
    val recovered: List<JSONObject> = emptyList(),
    val failures: List<String> = emptyList(),
    val unresolved: List<PendingFinancialOperation> = emptyList(),
    val legacyUnkeyed: List<PendingFinancialOperation> = emptyList(),
)

/** Narrow transport seam so replay state is unit-testable without Android/OkHttp. */
interface SalaryMutationGateway {
    suspend fun sendExact(operation: PendingFinancialOperation): JSONObject
    suspend fun lookup(operationId: String): FinancialOperationResult
}

/** Storage seam; the production adapter delegates to [OperationReplayStore]. */
interface SalaryPendingOperationStore {
    suspend fun record(scope: FinancialScope, operation: PendingFinancialOperation)
    suspend fun remove(scope: FinancialScope, operationId: String)
    fun list(scope: FinancialScope): List<PendingFinancialOperation>
}

class OperationReplaySalaryStore(private val store: OperationReplayStore) : SalaryPendingOperationStore {
    override suspend fun record(scope: FinancialScope, operation: PendingFinancialOperation) {
        store.record(scope.serverBaseUrl, scope.storageIdentity, operation)
    }

    override suspend fun remove(scope: FinancialScope, operationId: String) {
        store.remove(scope.serverBaseUrl, scope.storageIdentity, operationId)
    }

    override fun list(scope: FinancialScope): List<PendingFinancialOperation> =
        store.list(scope.serverBaseUrl, scope.storageIdentity)
}

/**
 * Salary create replay state machine.
 *
 * Invariants enforced here rather than in Compose:
 * 1. scope resolves a verified immutable user ID/baseURL before any record (username only on legacy servers);
 * 2. the exact pending request is committed synchronously BEFORE send;
 * 3. unknown outcomes keep the pending row and retries reuse its operationId;
 * 4. a definitive 4xx clears the row; a committed success clears it best-effort
 *    without turning local cleanup failure into a reported save failure.
 */
class SalaryReplayCoordinator(
    private val gateway: SalaryMutationGateway,
    private val store: SalaryPendingOperationStore,
    private val scopeProvider: suspend () -> FinancialScope,
) {
    suspend fun create(request: SalaryCreateRequest): SalaryMutationOutcome {
        val scope = try {
            scopeProvider()
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            throw e
        } catch (e: Exception) {
            return SalaryMutationOutcome.DefinitiveFailure(
                e.message?.takeIf { it.isNotBlank() } ?: "无法确认登录用户，已阻止创建工资。",
            )
        }
        val operation = PendingFinancialOperation(
            operationId = request.operationId,
            method = SalaryCreateRequest.METHOD,
            path = SalaryCreateRequest.PATH,
            payloadJson = request.payloadJson,
        )
        if (!isSafelyKeyedSalaryOperation(operation)) {
            return SalaryMutationOutcome.DefinitiveFailure("工资请求缺少一致的 operationId，已阻止创建。")
        }
        try {
            store.record(scope, operation)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return SalaryMutationOutcome.DefinitiveFailure(
                e.message?.takeIf { it.isNotBlank() } ?: "无法安全记录待执行工资，已阻止请求。",
            )
        }

        // A user/server switch between persistence and dispatch must not send the
        // request under a different account than the one the pending row belongs to.
        val scopeNow = try {
            scopeProvider()
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            throw e
        } catch (e: Exception) {
            return SalaryMutationOutcome.Unknown("登录状态在保存前发生变化，工资结果未知，请重新登录后核对。")
        }
        if (!scopeNow.sameIdentity(scope)) {
            return SalaryMutationOutcome.Unknown("登录用户或服务端地址在保存前发生变化，已阻止发送；请切回原账号后重试。")
        }
        return send(scopeNow, operation, alreadyPersisted = true)
    }

    /** Retry a known pending salary request without generating a new key. */
    suspend fun retry(operation: PendingFinancialOperation): SalaryMutationOutcome {
        val scope = try {
            scopeProvider()
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            throw e
        } catch (e: Exception) {
            return SalaryMutationOutcome.Unknown("无法确认登录用户，工资结果仍未知。")
        }
        if (operation.method != SalaryCreateRequest.METHOD || operation.path != SalaryCreateRequest.PATH) {
            return SalaryMutationOutcome.DefinitiveFailure("待重放操作不是工资创建请求。")
        }
        if (!isSafelyKeyedSalaryOperation(operation)) {
            return SalaryMutationOutcome.Unknown("历史工资请求缺少一致的 operationId，已阻止自动重发以防重复；请核对历史工资后显式结束此记录。")
        }
        return send(scope, operation, alreadyPersisted = true)
    }

    /**
     * Recover after process restart: first ask the server whether an operation
     * committed; only an authenticated 404 means it is safe to replay the exact
     * stored request. Unknown transport failures keep the row for another try.
     */
    suspend fun recover(): SalaryRecoveryReport {
        val scope = try {
            scopeProvider()
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            throw e
        } catch (e: Exception) {
            return SalaryRecoveryReport(failures = listOf("无法确认登录用户，未能恢复待核对工资。"))
        }
        val pending = store.list(scope).filter {
            it.method == SalaryCreateRequest.METHOD && it.path == SalaryCreateRequest.PATH
        }.sortedBy { it.createdAt }
        if (pending.isEmpty()) return SalaryRecoveryReport()

        val recovered = mutableListOf<JSONObject>()
        val failures = mutableListOf<String>()
        val unresolved = mutableListOf<PendingFinancialOperation>()
        val legacyUnkeyed = mutableListOf<PendingFinancialOperation>()
        for (operation in pending) {
            if (!isSafelyKeyedSalaryOperation(operation)) {
                legacyUnkeyed.add(operation)
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
                    shouldReplay = true
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
                removeBestEffort(scope, operation.operationId)
                recovered.add(lookup.response)
                continue
            }
            if (!shouldReplay) continue

            when (val outcome = send(scope, operation, alreadyPersisted = true)) {
                is SalaryMutationOutcome.Success -> recovered.add(outcome.salary)
                is SalaryMutationOutcome.DefinitiveFailure -> failures.add(outcome.message)
                is SalaryMutationOutcome.Unknown -> unresolved.add(operation)
            }
        }
        return SalaryRecoveryReport(
            recovered = recovered,
            failures = failures,
            unresolved = unresolved,
            legacyUnkeyed = legacyUnkeyed,
        )
    }

    private suspend fun send(
        scope: FinancialScope,
        operation: PendingFinancialOperation,
        alreadyPersisted: Boolean,
    ): SalaryMutationOutcome {
        check(alreadyPersisted)
        return try {
            val salary = gateway.sendExact(operation)
            removeBestEffort(scope, operation.operationId)
            SalaryMutationOutcome.Success(salary)
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthExpiredException) {
            throw e
        } catch (e: Exception) {
            when (val failure = classifyFinancialWriteFailure(e)) {
                is FinancialWriteFailure.Rejected -> {
                    removeBestEffort(scope, operation.operationId)
                    SalaryMutationOutcome.DefinitiveFailure(failure.message)
                }
                is FinancialWriteFailure.Unknown -> SalaryMutationOutcome.Unknown(failure.message)
                FinancialWriteFailure.AuthExpired -> throw AuthExpiredException()
            }
        }
    }

    private suspend fun removeBestEffort(scope: FinancialScope, operationId: String) {
        runCatching { store.remove(scope, operationId) }
    }
}

internal fun FinancialScope.sameIdentity(other: FinancialScope): Boolean =
    serverBaseUrl == other.serverBaseUrl && storageIdentity == other.storageIdentity
