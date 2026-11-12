package com.yansuu1.controller;

import com.alibaba.cloud.ai.graph.exception.GraphRunnerException;
import com.yansuu1.service.AgentService;
import lombok.RequiredArgsConstructor;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.model.Generation;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * @auth yansuu1
 * @date 2026/11/9
 */

@RestController
@RequestMapping("/ai")
@RequiredArgsConstructor
public class AiController {

  private final AgentService accountingAiService;

  @PostMapping("/chat")
  public ChatResponse chat(@RequestBody Prompt request) throws GraphRunnerException {

    AssistantMessage result = accountingAiService.chat(request);
    return new ChatResponse(List.of(new Generation(result)));
  }

  @GetMapping("/chat/test")
  public ChatResponse chatTest(@RequestParam String request) throws GraphRunnerException {

    AssistantMessage result = accountingAiService.chat(new Prompt(request));
    return new ChatResponse(List.of(new Generation(result)));
  }


  @PostMapping("/chat/draft")
  public ChatResponse draft(@RequestBody Prompt request) throws GraphRunnerException {

    AssistantMessage result = accountingAiService.chat(new Prompt(request));
    return new ChatResponse(List.of(new Generation(result)));
  }


}
