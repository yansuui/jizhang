package com.yansuu1.service.impl;

import com.alibaba.cloud.ai.graph.agent.ReactAgent;
import com.alibaba.cloud.ai.graph.exception.GraphRunnerException;
import com.yansuu1.service.AgentService;
import lombok.RequiredArgsConstructor;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.stereotype.Service;

/**
 * @auth yansuu1
 * @date 2026/11/10
 */

@Service
@RequiredArgsConstructor
public class BookKeepingAIService implements AgentService {

  private final ReactAgent bookKeepingAgent ;

  @Override
  public AssistantMessage chat(Prompt request) throws GraphRunnerException {
    return null;
  }
}
