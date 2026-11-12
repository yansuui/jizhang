package com.yansuu1.config;

import com.alibaba.cloud.ai.graph.agent.ReactAgent;
import com.yansuu1.entity.dto.TransactionDraftResponseDTO;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * @auth yansuu1
 * @date 2026/11/9
 */

@Configuration
public class AgentConfig {

  @Bean
  public ReactAgent accountingAgent(ChatModel chatModel){
    return  ReactAgent.builder()
                      .model(chatModel)
                      .systemPrompt("""
                                    你是一个专业的个人记账 AI 助理。

                                    你的职责：
                                    1. 回答用户关于记账的问题。
                                    2. 帮助用户识别消费分类。
                                    3. 提供合理的预算建议。
                                    4. 使用简洁、友好的中文回复。

                                    当前尚未连接真实记账数据库。
                                    不要声称已经保存或查询了账单。
                                    """)
                      .name("accountingAgent")
                      .build();
  }

  @Bean
  public ReactAgent bookKeepingAgent(ChatModel chatModel){
    return ReactAgent.builder()
      .outputType(TransactionDraftResponseDTO.class)
      .name("bookKeepingAgent")
      .model(chatModel)
      .systemPrompt("你是一个专业的记账助理，你通过和用户交流来总结获取需要记账的数据，在真正记录前需要用户手动确认数据")
      .build();
  }
}
