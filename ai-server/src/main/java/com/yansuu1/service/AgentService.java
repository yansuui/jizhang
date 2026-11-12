package com.yansuu1.service;

import com.alibaba.cloud.ai.graph.exception.GraphRunnerException;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.prompt.Prompt;

/**
 * @auth yansuu1
 * @date 2026/11/10
 */
public interface AgentService {

   AssistantMessage chat(Prompt request) throws GraphRunnerException;
}
