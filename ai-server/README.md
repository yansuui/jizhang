# 11.09
1.bom引入，只引入pom版本不引入jar
<dependency>
        <groupId>com.alibaba.cloud.ai</groupId>
        <artifactId>spring-ai-alibaba-bom</artifactId>
        <version>1.1.2.0</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
# 11.10
配置模型的时候注意
spring:
ai:
model:
chat: openai ##启用 OpenAI ChatModel 自动配置
embedding: none
openai:
chat:
options:
model: gpt-6-luna ## 实际模型
