package com.yansuu1.entity.dto;

import java.math.BigDecimal;
import java.util.List;

/**
 * 模型返回草稿record
 * @auth yansuu1
 * @date 2026/11/10
 */

public record TransactionDraftResponseDTO (
  Integer type,
  Long amountCents,
  String categoryId,
  String accountId,
  Long date,
  String note,
  List<String> tags,
  BigDecimal confidence,
  String reason,
  List<String> missing
){
}
