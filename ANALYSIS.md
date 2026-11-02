# 超星 AI 馆员（robot.chaoxing.com/coze）系统分析

目标页面：`https://robot.chaoxing.com/coze/mobile?unitId=21354&robotId=dfda0d9629b34e0fa59a9b57834b8c56`
租户 `unitId=21354`（沈阳农业大学），机器人 `robotId=dfda0d9629b34e0fa59a9b57834b8c56`（AI馆员）。

结论先行：**该页面不依赖登录态**。匿名 visitor 即可完成完整问答，前端只做两件事——用一组 HTTP 接口建立
visitor/会话，然后用一条 WebSocket 完成提问与流式回答。所谓“反代”因此并不需要破解签名：把 HTTP、静态资源
和 WebSocket 三条链路原样透传，再自己实现一次 visitor 引导流程即可。

---

## 1. 分析方法与证据来源

分析严格遵守“先观察、后推断”的顺序，全部证据来自本地实测：

| 阶段 | 工具 | 产物 |
| --- | --- | --- |
| 页面与静态资源采集 | `rea-agents@6.8.0`（仓库 `morluto/rea`）的 `list-browser-targets`、`inspect-web-page` | CDP 目标清单、页面 DOM/网络元数据 |
| 静态包体分析 | `rea analyze-web-bundle`（同一仓库，本地 CDP 附加，不执行目标 JS） | 63 个脚本的端点候选清单，`probe/bundle-full.json` |
| 运行时流量抓取 | 自建 CDP 客户端（`Network.*`，开启 `Target.setAutoAttach` 全目标抓取） | 加载期 176–223 条请求、WebSocket 握手头与逐帧内容 |
| 协议验证 | 独立 Node 探针直接跑 visitor/apply + WS 提问 | 4 类问题的完整帧序列 |

REA 的定位是“本地、被动、带证据链”的逆向工具，本次只用了它的浏览器观察与静态包体能力；README 也明确
它不执行目标 JavaScript，所以帧级结论最终由自建探针实测确认，静态候选仅用于交叉验证。

静态分析给出的端点候选与动态抓取完全对得上的关键几项：`/v1/front/chat/visitor/apply`、
`/v1/front/chat/connect/{unitId}`、`/v1/ws/chat/{unitId}/visitor`、`/v1/front/msgList`、
`/v1/front/llm/getModelSettingInfo`。

---

## 2. 前端结构

- 单页应用：Vue 2.7.16 + vue-router 3 + Vuex 3 + Element UI 2.15.14，webpack 5 分包（`runtime`、`vendors`、`index` 加按需 chunk）。
- 入口 HTML 只做三件事：加载 `/static/js/preview.*.js`、注入 `window.fe_version`、准备 `#app` 挂载点和骨架 loading。
- 服务端渲染的只有一个空壳，所有内容靠 XHR/WebSocket 拉取，因此**反代只需处理同源 `/static`、`/sdk`、`/v1`、`/coze` 路径**，跨域静态资源（`robot-static.chaoxing.com`、`noteyd.chaoxing.com`、`p.ananas.chaoxing.com`）本身带宽松 CORS，可直连。
- 页面在 `istudy.szpt.edu.cn` 域名下会把 API 基址切到 `//robot.istudy.szpt.edu.cn`，其余情况用相对路径 `/`，即与页面同源——这正是可以整体反代的前提。

### 反爬/风控观察

- **UA 敏感**：默认 headless Chrome 访问直接返回 `403 Forbidden`（页面标题为 403）；带移动端 UA 后正常 200。因此反代必须固定一个正常 UA 转发，不能用 Node 默认 UA。
- 请求头 `fe_version`（`d2796afa2.26103019-production`）被页面带到每个 XHR 上，服务端未强制校验，但反代保持透传。
- 存在 `captcha.chaoxing.com/load.min.js` 与 `/v1/api/websdk/*` 校验链路（`websdk/get` 取 token、`websdk/verify` 校验 `appId=108717302`），实测**匿名问答并不需要**通过它；WS 握手也不校验该 token。
- 没有任何 `Authorization`、`signature`、`access_token` 参与本场景的问答接口。

---

## 3. 会话建立：三个 HTTP 请求

```
GET /v1/front/chat/visitor/apply
      ?unitId=21354&robotId=<robotId>&visitorId=&channel=MOBILE&isLLMPlanning=0
返回 { visitorId, visitorVc, cvsInfo: { conversationId, chatStatus }, isNewVisitor }
```

关键点（也是最初踩坑的地方）：**服务端会下发自己的 `visitorId`，不是你传入的那个**。若沿用自造的 UUID
去连 WebSocket，握手成功后约 40 ms 即被 `1000` 关闭。必须使用 `apply` 返回的 `visitorId` + `visitorVc`。

```
GET /v1/front/chat/connect/21354?visitorId=<serverIssued>&conversationId=<cvsInfo.conversationId>&robotId=<robotId>
返回 { "status": true }
```

浏览器端还会 `POST /v1/front/chat/initCookie`（写入 visitor 绑定）以及 `POST /v1/front/msgList`、
`/v1/front/conversationList` 等历史接口；实测这三个请求对匿名问答不是必需的，只用 `apply` + `connect` 即可。

浏览器实际保存的身份是两条 cookie：`visitorId`、`visitorVc`（无 Domain，说明前端自己写 cookie）。
多轮上下文由**服务端按 `conversationId` 维护**，复用一个 visitor + conversationId 即可延续对话（已实测：
先“记住我叫王小明”，再问“我叫什么名字”，可正确复述）。

---

## 4. 问答链路：一条 WebSocket

```
wss://robot.chaoxing.com/v1/ws/chat/21354/visitor
    ?unitId=21354&robotId=<robotId>&userId=<visitorId>&channel=MOBILE
    &conversationId=<conversationId>&visitorVc=<visitorVc>&lang=zh-CN&isLLMPlanning=0
```

握手时必须带 `Cookie: visitorId=...; visitorVc=...` 且 `Origin: https://robot.chaoxing.com`。
浏览器另带 `Cache-Control: no-cache`、`Accept-Language`、`permessage-deflate`，实测可省略（deflate 非必需）。

### 上行帧（一条消息一帧）

```json
{
  "msgTimeId": 1793619881081, "time": 1793619881081,
  "direction": "IN", "messageType": "TEXT", "communicateType": "DATA", "lang": "zh-CN",
  "msg": {
    "channel": "WEB",
    "question": "如何借阅图书？", "visibleQuestion": "如何借阅图书？",
    "questionType": "TEXT", "fileInfo": [],
    "chatModel": "DEFAULT", "sourceChatModel": "DEFAULT",
    "digitalHumanName": "ai馆员", "taskInitParams": {}
  },
  "robot": { "type": "", "scene": -1, "subject": "", "spage": 1 },
  "dxNumber": "", "d": ""
}
```

心跳：`{"type":"KEEPALIVE"}`，浏览器每 30 s 一次。

### 下行帧类型

| 类型 | 形态 | 含义 |
| --- | --- | --- |
| `SEMANTIC` | `{type:"SEMANTIC", agent_event:{event:"..."}, meta:{description}}` | 思考过程：`knowledge_question_thought`、`intent_rec_thought`、`task_flow_result`… |
| `FINAL_FINISH` | `{type:"FINAL_FINISH", meta:{description:"[{\"name\":\"总耗时\",...}]"}}` | 语义流程结束（早于正文，不等于回答结束） |
| `DATA` + `answerContentType:"TEXT"` | `answer` 为纯文本或 JSON 字符串 | 正文 |
| `DATA` + `answerContentType:"TASK_FLOW_V3"` | `answer` 为 `{"message":"正在生成中"}`，带 `taskName`、`mobileIframeUrl` | 任务流（跳转 iframe 页面） |
| `DATA` + `answerContentType:"ACK_MSG"` | `answer:""` | 送达确认 |
| `DATA` + `robotRespType:"BUSINESS_QA"` | 可带 `mobileIframeUrl` | 业务卡片/iframe |

`answer` 的三类负载：

1. **问答库命中**：单帧纯文本（一次性给全），例如 `周一至周日：6:30—22:00（法定节假日闭馆除外）`，
   同一轮里先到的 `systemMsg:true` 帧是“匹配到的标准问”，不是答案。
2. **大模型流式**：JSON 字符串，逐块带 `index`、`responseText`；结束时 `flag:"stop"`。
   例如 `{"docRecallLlmNoResult":false,"index":5,"responseText":"你好！很高兴再次见到你～",...}`。
3. **任务流**：`{"message":"正在生成中"}` + `mobileIframeUrl`（如馆藏查询页），`taskEnd` 表示流程结束。

### 完成判定

- 流式：`flag === "stop"` 明确结束（实测 4.9 s 左右）。
- 问答库：没有显式结束帧，最后一条正文后不再有帧。
- 因此代理采用「显式 stop 立即结束，否则静默超时结束」的策略：默认静默窗口 3 s
  （实测最大帧间隔约 1.5 s，1.2 s 会截断流式回答），单题硬超时 120 s。
- 首轮偶发空回答（新 visitor 的竞态）：代理对「零正文」自动重试一次。

### 上游模型

`/v1/front/llm/getModelSettingInfo` 显示该机器人默认模型 `defaultModelId=254`，即
`deepseek-v4-flash-0731`（DeepSeek），可切换 `huiya-chat-34-q4`（汇雅）、`kimi-k2.5`（moonshot）、
`ernie-5.1`（文心）。页面底部展示的正是 `deepseek-v4-flash-0731`。

---

## 5. 端点清单（节选）

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `/v1/front/chat/visitor/apply` | GET | 创建/恢复匿名 visitor，返回 `visitorId`/`visitorVc`/`conversationId` |
| `/v1/front/chat/connect/{unitId}` | GET | 注册会话，返回 `{status:true}` |
| `/v1/ws/chat/{unitId}/visitor` | WS | 问答主通道 |
| `/v1/front/chat/initCookie` | POST | visitor 绑定（可选） |
| `/v1/front/msgList`、`/v1/front/conversationList` | GET | 历史消息、会话列表 |
| `/v1/front/llm/getModelSettingInfo` | GET | 模型与思考过程配置 |
| `/v1/front/robot/info/{robotId}` | GET | 机器人资料（`AI馆员`，6 个字段含 `switchWelcome`） |
| `/v1/front/getInfoByUnitId`、`/v1/front/getStartPage`、`/v1/front/unStatis/prompt` | GET | 机构信息、欢迎页、未统计提示 |
| `/static/js/*`、`/static/css/*`、`/sdk/*` | GET | SPA 资源 |
| `/v1/api/websdk/get`、`/v1/api/websdk/verify` | GET/POST | 反爬校验（本场景可绕过） |

未纳入范围：`/v1/manage/**` 属于后台管理面，需要超星管理端登录态，本次没有触碰，也没有写任何写操作。

---

## 6. 反代设计

三条链路，全部同源转发，客户端零改造：

1. **HTTP 透传**（`/v1/**`、`/static/**`、`/sdk/**`、`/coze/**`、`/richview`）：转发到
   `robot.chaoxing.com`，注入正常 UA / `Referer` / `fe_version`，剥掉 `X-Frame-Options`、`CSP`、
   `HSTS`，并把上游 `Set-Cookie` 的 `Domain`、`Secure` 去掉——这样 cookie 才能落在本地域名上，
   SPA 的 `withCredentials` 链路才闭合。
2. **WebSocket 透传**（`/v1/ws/**`）：把浏览器升级请求转成上游 `wss`，保留原始 query 与 cookie，
   `Origin` 改写为上游源，双向透传帧。SPA 里 `location.origin` 拼出来的 `ws://` 地址自然落回代理。
3. **协议适配**：额外实现 `visitor/apply → connect → WS 提问` 的引导与帧解析，对外提供
   自有 SSE（`POST /api/chat`）与 OpenAI 兼容接口（`POST /v1/chat/completions`，支持 `stream`），
   让这套能力可以直接接到任意 LLM 客户端。

这两条链路都已用真实浏览器验证：代理后的原始页面（`/coze/mobile?...`）能正常渲染、提问并返回答案，
WebSocket 走的是代理自己的 `/v1/ws/chat/...`。

---

## 7. 工具调用：为什么不能直接用原生实现

先查“能不能原生支持”，再决定要不要自己造循环。结论是**前台协议完全不支持客户端工具**：

| 检查项 | 结果 |
| --- | --- |
| WS 上行帧字段 | `msg` 里只有 `channel`/`question`/`questionType`/`fileInfo`/`chatModel`/`taskInitParams` 等，没有 `tools`、`tool_choice`、`functions` |
| 下行帧字段 | 没有 `tool_calls` / `function_call`；只有 `SEMANTIC` 进度、`DATA` 正文、`TASK_FLOW_V3` 服务端任务流 |
| SPA 包体检索 | `"tools"`、`tool_calls`、`functionCall`、`toolCall`、`"mcp"` 在入口包与 6 MB 主 chunk 中命中数均为 **0** |
| `chatModel` 取值 | 只有 `DEFAULT` / `APP` / `PLUGIN` / `multi_knowledge` 这类**服务端**能力开关（配合 `taskId`、`pluginId`、`skillMeta`），不是客户端工具声明 |
| MCP / 工具管理接口 | `/v1/manage/robot/robotMcpInfo/*`、`/v1/manage/robot/robotToolRelation/*`、`/v1/manage/taskFlow/llm/toolCall/*` 全在管理面，需要超星管理端登录态，前台拿不到也改不了 |
| 机器人自身工具 | 馆藏查询这类能力是**服务端**跑完再回一个 `mobileIframeUrl`，客户端只是渲染 iframe，无法注入自己的工具 |

也就是说：上游的“agent 能力”属于它自己的工具集，客户端无法把自定义 tools 带进去，更不会拿到
`tool_calls` 让你本地执行。

### 采用的替代方案：提示词层协议 + 本地真执行

既然拿不到结构化 tool_calls，就把工具约定写进提示词，让模型用**一行 JSON** 表达调用意图：

```
model  → {"tool":"now","args":{}}
proxy  → 本地执行 → 把 “工具 now 的执行结果：{...}” + 原始问题 回灌
model  → 继续 JSON 或直接给最终中文回答
```

工程要点（都踩过）：

1. **必须把原始问题一起回灌**。只发工具结果时，模型会答“请问您最初的问题是什么”，因为它把工具结果
   当成了新话题；把 `用户最初的问题是：「…」` 拼进观察消息后，末轮回答才稳定命中原始问题。
2. **解析要容错**：模型偶尔包 ```` ```json ```` 代码块或加一句“好的，我来调用：”。解析器依次尝试整串、
   首个 `{...}`、`name`/`function.name` 变体，`arguments` 为字符串时二次解析。
3. **首字节判定即分流**：回答以 `{` 开头就按工具调用缓冲（不向用户吐 JSON），否则边收边流式输出。
4. **轮数硬上限 + 重复检测**：同一 `tool:args` 连续出现两次就提示换策略，达到上限后发一条“请直接给结论”
   的收尾请求，保证一定有答案。
5. **观察消息截断**：工具结果最多 6000 字符，避免把上下文灌爆（上游对超长输入会直接截断或降质）。
6. **别名兜底**：模型会自创 `fetch_url`、`shell`、`cat` 这类“看起来合理”的名字，代理做了别名映射到真实工具；
   未命中时回一条带可用工具清单的错误，模型下一轮基本能纠正。

### 实测结果

- 协议遵从性探针 3/3：问“现在几点”得到 `{"tool":"now","args":{}}`，回灌结果后得到正确时间；
  问网页标题得到 `{"tool":"http_get","args":{"url":"https://example.com"}}`。
- 端到端 4/4 工具场景：`now`、`http_get`（真实抓取 example.com 标题）、`write_file`（真实落盘）、
  `exec`（真实执行 PowerShell，返回 `D:\…\agent-sandbox`）。
- 多步链式：一句“把时间写入文件并抓取标题”触发 `now → write_file → http_get` 三个工具、4 轮，最终回答同时覆盖两件事。
- 轮数上限：`maxRounds=2` 时恰好 2 次工具调用后收尾，`finishReason=max_rounds`。

代价是延迟：每次工具调用要多一次完整的上游问答往返（单轮 4–6 s），两三个工具约 15–20 s；
换来的是不依赖上游任何工具协议，且工具集可以随时扩展。

业界同类方案的调研（litellm 的 `add_function_to_prompt`、smolagents 的 code-as-action、langchain 的 ReAct、
instructor 的校验重试、guidance/outlines 的受约束解码）见 [docs/RESEARCH-ask-to-agent.md](docs/RESEARCH-ask-to-agent.md)。

最终落地的是**代码即动作**：模型每个回合写一个 ```` ```js ```` 块，脚本在 fork 出的子进程里执行，
子进程以 Node `--permission` 启动（文件系统/网络/子进程默认拒绝），工具调用经 IPC 回到父进程执行。
选它的原因很直接——上游每轮 4–6 s，「取时间 + 写文件 + 抓网页」这类任务，JSON 单调用要 4 轮，
代码动作 2 步就做完。`test/sandbox-test.mjs` 验证了越权读取、动态 import、`new Function`、死循环都被拦下。

## 8. 未知与限制

- `answer` 内层 JSON 还有 `longTermMemory`、`fromSource`、`docRecallLlmNoResult` 等字段未逐一定义含义，代理只消费
  `responseText` / `flag` / `message`。
- 任务流（`TASK_FLOW_V3`）只透出 `taskName` 与 `mobileIframeUrl`，其内部多轮槽位填充未逆向。
- 完成判定是启发式的（显式 stop + 静默窗口），极端慢速网络下可能提前收尾，可用 `ANSWER_IDLE_MS` 调整。
- 上游没有任何客户端凭证，意味着服务端可随时加签名、限流或地区限制；代理层已把 visitor 建立、重试、
  会话保持收敛到一处，便于后续适配。
- 未评估上游对同一 IP 高频请求的风控策略；生产化部署应加自己的限流与缓存。
- 工具调用是提示词约定：模型若把 JSON 写成多行、或在中途改口，本轮会被当成最终答案返回（只会少执行工具，
  不会误执行）。若上游以后支持原生 tool_calls，`src/agent.mjs` 只需替换“解析 + 回灌”两层。
