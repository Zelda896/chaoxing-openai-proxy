# 免责声明 / Disclaimer

本项目是一个**技术研究与学习性质**的本地代理工具，用于演示如何：

- 逆向分析 Web 应用的公开前端协议（HTTP / WebSocket）；
- 把非 OpenAI 协议的对话服务适配成 OpenAI 兼容接口；
- 在沙箱中安全地执行模型生成的代码。

## 使用须知

1. **非官方**：本项目与超星（chaoxing.com）及其关联公司**没有任何关系**，未获其授权、认可或支持。
2. **合规责任自负**：使用者需自行确保其使用行为符合目标站点的服务条款（ToS）、robots 协议以及
   所在地区的法律法规。**请勿用于商业用途、大规模抓取、绕过付费墙或任何未经授权的场景。**
3. **不做保证**：作者不对可用性、稳定性、数据准确性作任何担保。上游服务随时可能变更协议、加签名或限流，
   届时本项目可能失效。
4. **数据与隐私**：代理会把你的提问转发给上游服务，请勿提交敏感个人信息、密钥或保密材料。
   Agent 模式下的本地工具会真实读写文件、执行命令，请务必自行审阅配置（尤其 `AGENT_ROOT`、
   `AGENT_ALLOW_EXEC`），**不建议在存放敏感数据的机器上开启 `exec`**。
5. **禁止滥用**：请勿将本项目部署为公开的免费 API 服务对外提供，避免给上游造成压力或引发滥用风险。

## 关于逆向分析

本项目涉及的前端协议信息全部来自公开可得的网页客户端（静态 JS 与分析工具），
分析过程记录在 [ANALYSIS.md](ANALYSIS.md)。项目**不包含**任何反编译的二进制、破解补丁、
绕过鉴权的代码或上游的私有数据。

若权利人认为本项目侵犯其权益，请提交 Issue 或直接联系维护者，我们会及时处理（包括下架相关内容）。

## English

This project is a **research and educational** local proxy. It is **not affiliated with, endorsed by, or
supported by** chaoxing.com. Users are solely responsible for complying with the target service's Terms of
Service and applicable laws. Do not use it commercially, for bulk scraping, to bypass paywalls, or in any
unauthorized manner. No warranty of any kind is provided.

The reverse-engineering notes come only from publicly served front-end assets and browser observation,
documented in [ANALYSIS.md](ANALYSIS.md). The repository contains no decompiled binaries, no cracking code,
and no authentication bypass.
