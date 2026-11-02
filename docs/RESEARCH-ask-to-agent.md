# 把「只会对话的 ask 模型」变成 agent：GitHub 上的现成做法

目标：我们的上游（超星 AI 馆员）只有一问一答的 WS 协议，没有 `tools` / `tool_calls`。
问题变成——**业界是怎么把这种纯对话模型包装成会调工具的 agent 的？有没有高星仓库可以直接抄？**

下面所有 star 数取自 GitHub API（本次调研时实测），按“对黑盒远程模型是否可用”排序。

## 一、结论速览

| 做法 | 代表仓库 | Star | 对黑盒远程 API 可用 | 说明 |
| --- | --- | --- | --- | --- |
| 把工具 schema 拼进 prompt，解析模型输出的 JSON | [BerriAI/litellm](https://github.com/BerriAI/litellm) | 62,549 | ✅ | `add_function_to_prompt` / `supports_function_calling`，就是“模型不支持原生 function calling 时改用文本协议” |
| ReAct 文本循环（Thought → Action → Observation） | [langchain-ai/langchain](https://github.com/langchain-ai/langchain) | 148,878 | ✅ | `create_react_agent` 的经典 prompt 模板 |
| 同上，图编排版本 | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | 44,331 | ✅ | ReAct 作为图节点，带状态与重试 |
| **代码即动作**：模型写 JS/Python 调工具 | [huggingface/smolagents](https://github.com/huggingface/smolagents) | 30,188 | ✅ | `CodeAgent` 对任何模型可用；官方称比 JSON 工具字典少约 30% 步骤 |
| 结构化输出 + 校验失败重试 | [567-labs/instructor](https://github.com/567-labs/instructor) | 14,091 | ✅ | 解析失败把错误回灌，让模型重出，正是“解析健壮性”的标准解 |
| 受约束解码（语法强制 JSON） | [guidance-ai/guidance](https://github.com/guidance-ai/guidance) 21,813 · [dottxt-ai/outlines](https://github.com/dottxt-ai/outlines) 15,995 · [sgl-project/sglang](https://github.com/sgl-project/sglang) 38,369 | — | ❌ | 需要控制采样器（本地/自托管模型）；远程 API 只能拿到已生成的文本 |
| Agent 运行时（假设原生 tool calling） | [microsoft/autogen](https://github.com/microsoft/autogen) 61,676 · [openai/openai-agents-python](https://github.com/openai/openai-agents-python) 30,455 | — | ⚠️ | 框架本身要求模型输出结构化 `tool_calls`，对纯文本模型不适用 |
| 字面意义的“给任何 LLM 加 tool calling”的代理 | [Oct4Pie/toolbridge](https://github.com/Oct4Pie/toolbridge) 81 · [ll1r1k-1337/llm-tool-capability](https://github.com/ll1r1k-1337/llm-tool-capability) 7 | — | ✅ | 和我们的思路完全同构（prompt 注入 + 流式解析 + agentic loop），但都是小仓库 |

一句话：**高星项目里没有“一键把 ask 模型变 agent”的现成轮子**，但每一种成熟做法都有明确代表：
企业级网关（litellm）选“prompt 注入”，老牌框架选 ReAct 文本循环，最受关注的轻量库（smolagents）选“代码即动作”，
而“受约束解码”这条路只对本地模型成立。

## 二、各方案到底怎么实现

### 1. 提示词注入（litellm 路线）

LiteLLM 在 `add_function_to_prompt` 里做的事：模型 `supports_function_calling == False` 时，
把 `tools` 的 name/description/parameters 渲染成一段文本塞进对话，再解析模型回复里的 JSON 作为调用。
它同时维护了 `supports_function_calling(model=...)` 的能力表，让调用方不必关心底层差异。

对我们的映射：完全等价于我们已经实现的 JSON 模式，区别只是我们在**协议层**做（WS 帧），
而不是在 OpenAI 兼容层做。

### 2. ReAct 文本循环（langchain / llama_index 路线）

```
Thought: 我需要知道现在几点
Action: now
Action Input: {}
Observation: {"iso":"2026-11-02T12:34:56Z", ...}
Thought: 我可以回答了
Final Answer: 现在是……
```

优点：模型只要会写文本就能跑，可解释、可中断。
缺点：每步一次往返，格式靠正则；对“只输出 JSON”的强约束模型容易串味。

我们的 JSON 模式其实是它的压缩版（省掉 Thought，直接给一行 JSON）。

### 3. 代码即动作（smolagents 路线，最值得抄的部分）

smolagents 的 README 写得很直白：`CodeAgent` 让模型把动作写成代码，**任何 LLM 都能用**，
并引用了他们自己的评测——比“输出工具字典”的写法少约 30% 的步骤、在高难度基准上更好。
代价是必须沙箱执行（他们提供 E2B / Modal / Docker，明确说 `LocalPythonExecutor` 不是安全边界）。

对我们的映射：我们把动作改成 JS（Node 原生可跑 `node:vm`），工具通过 `callTool(name, args)` 暴露，
一个代码块里可以连续调多个工具、循环处理结果——**这是减少往返次数最有效的方法**，因为我们的瓶颈正是每次往返 4–6 秒。

### 4. 校验 + 重试（instructor 路线）

instructor 的核心不是“让模型一次输出对”，而是“输出错了就带着错误信息重试”，直到通过 schema 校验。
我们的解析器已经吸收了这个思路（别名修正、代码块剥离、坏 JSON 回灌一次），但没有做强制 schema 校验——
因为我们的工具参数很简单，值不值得引入 zod 级的校验取决于工具复杂度；接业务 API 时应该加上。

### 5. 受约束解码（guidance / outlines / sglang）

原理是在采样时把 token 限制在合法语法内，从根上消灭“JSON 写歪”。
前提是你能控制 logits 或至少控制 sampler——**远程黑盒 API 无法使用**。
如果以后把这套反代接到本地模型（vLLM/SGLang），这条才是最优解，届时可以替换掉“提示词 + 正则”。

## 三、这套代码里实际落地了什么

**结论：只保留一种方法——代码即动作（code-as-action + 沙箱），默认启用，不再有 JSON/代码双模式。**

理由：这套反代的瓶颈完全在上游往返（4–6 s/次），而代码动作是唯一能“一次回合干多件事”的形态。
同一句「取时间 + 写文件 + 抓网页」，JSON 单调用要 4 轮，代码动作 2 步完成。

实现要点（对应文件）：

| 关注点 | 实现 |
| --- | --- |
| 动作格式 | 模型输出 ```js 代码块，内部 `await callTool("名字", {参数})`、`final_answer("...")` 收尾 |
| 沙箱 | [src/sandbox.mjs](../src/sandbox.mjs) fork 子进程（`--permission`），[src/runner.mjs](../src/runner.mjs) 在 `vm` 里执行，只注入 callTool/console/final_answer |
| 工具执行 | 工具在父进程跑（`AGENT_ROOT` 限定路径、拒绝内网 URL、exec 超时），结果经 IPC 回传 |
| 循环控制 | [src/agent.mjs](../src/agent.mjs)：最多 6 步（可配）、空回答/拒绝各重试一次、步数用完强制收尾 |
| 隔离验证 | [test/sandbox-test.mjs](../test/sandbox-test.mjs)：读 `C:/Windows/win.ini`、`import('node:fs')`、`new Function('return process')`、`while(true)` 全部拦截 |

被放弃的方案：

- **JSON 单调用**（litellm 路线）：能用，但每调一个工具多一轮往返，实测同样任务 4 轮 vs 2 步。
- **ReAct 文本循环**（langchain 路线）：思考步骤更啰嗦，往返更多，对本场景纯亏。
- **受约束解码**（guidance/outlines/sglang）：优雅但从根上不适用——我们控制不了上游采样器。
- **instructor 式 schema 校验**：工具参数简单，暂不需要；接业务 API 时值得补。

## 四、怎么选

- 只想稳定可用 → 代码动作默认配置即可（`AGENT_MAX_STEPS=6`、单步 30 s 超时）。
- 想让模型更“能干” → 加工具（`src/tools.mjs` 一个条目，两个模式都自动可用）。
- 想彻底消灭动作格式错误 → 换成可控采样的模型（vLLM/SGLang）上受约束解码。
- 想跑不可信输入 → 现在这层 `--permission` 子进程够用；要更强再换 E2B/Docker（smolagents 的同款建议）。

## 五、参考链接

- [BerriAI/litellm](https://github.com/BerriAI/litellm) · [prompt 注入测试用例](https://huggingface.co/spaces/ka1kuk/litellm/raw/main/litellm/tests/test_add_function_to_prompt.py)
- [huggingface/smolagents](https://github.com/huggingface/smolagents)（CodeAgent vs ToolCallingAgent）
- [langchain `create_react_agent`](https://reference.langchain.com/python/langchain-classic/agents/react/agent/create_react_agent)
- [567-labs/instructor](https://github.com/567-labs/instructor)
- [guidance-ai/guidance](https://github.com/guidance-ai/guidance) · [dottxt-ai/outlines](https://github.com/dottxt-ai/outlines) · [sgl-project/sglang](https://github.com/sgl-project/sglang)
- [Oct4Pie/toolbridge](https://github.com/Oct4Pie/toolbridge)
