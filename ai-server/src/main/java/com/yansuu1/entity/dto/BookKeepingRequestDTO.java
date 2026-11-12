package com.yansuu1.entity.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import lombok.Data;
import org.springframework.web.multipart.MultipartFile;

/**
 * @auth yansuu1
 * @date 2026/11/11
 */
@Data
public class BookKeepingRequestDTO{

  @Schema(description = "用户输入")
  String userMessage;

  @Schema(description= "文件")
  MultipartFile files;
}
