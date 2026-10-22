# AI 招聘简历智能筛选助手 — 设计说明

- 日期：2026-10-22
- 状态：已确认（用户批准 m00018）
- 目标场景：AI 自动化项目实习生面试 Demo，B2B 外贸企业 HR 在 BOSS 直聘的简历初筛

## 1. 问题与目标

HR 每天从 BOSS 直聘收到大量简历，人工初筛存在三个问题：重复劳动耗时、标准因人而异、对"简历没写"的
信息容易误判为"不具备"。Demo 目标不是把招聘决策交给 AI，而是把初筛做成**可解释、可追溯、可回归**的
半自动流程，把 HR 的精力释放到沟通与面试上。

非目标（明确排除，用于面试时划边界）：不做 BOSS 直聘爬取/账号代操作（平台协议与法律风险）、不做自动
发消息、不做最终录用决策、不做 OCR（扫描件仅提示）、不做多租户与权限体系。

## 2. 核心设计决策

### 决策一：模型只判定，分数由代码算

模型输出的是**逐条 rubric 的结构化判定**（met / partial / missing / unknown + 证据原句 + 一句话理由），
分数、覆盖率、结论由 `server/scoring/rules.js` 的纯函数计算。

理由：
1. **可复现**：同一判定集合永远得到同一分数，模型波动不会直接变成分数波动。
2. **可回归**：打分数学可以单元测试，模型换版本时能用固定判定集合验证行为不变。
3. **可解释**：HR 追问"为什么 78 分"时，答案是一张逐条命中表，而不是"模型觉得"。

被否方案：让模型直接输出 0-100 总分。否掉的理由是分数不可解释、不可复现，且模型对数字的先验会污染
判断（同一份简历两次跑分可能差 10 分，面试现场演示会翻车）。

### 决策二：判定引入第四态 `unknown`

`met / partial / missing` 三态无法表达"简历里没有相关信息"。把"没写"判成"missing"是人工初筛最常见的
系统性偏差，也是 AI 筛选最容易造成的误杀。

因此引入 `unknown`：不计入已确认分（不给同情分），但显式计入覆盖率损耗，并**自动生成向候选人追问的
问题**，对应 JD 要求里的「有待确认的条件」。结论模板中「待定 / 建议补充信息」这一档主要由 unknown 触发。

### 决策三：LLM 与规则引擎共用同一份输出契约

`server/llm/provider.js` 与 `server/scoring/rules.js`（规则引擎）产出**完全相同的 verdict schema**。
无 Key、超时、连续失败时自动降级到规则引擎，接口层无感知，UI 仅加「规则模式」角标。

理由：降级路径被设计而非补丁。面试现场无网络/无 Key 时仍能完整演示，且可以正面回答"模型挂了怎么办"。

### 决策四：证据必须可校验

模型给出的每条 `evidence` 都要在简历原文中做归一化 substring 命中，命中失败则标记
`evidenceVerified: false` 并在 UI 里显示「引用未验证」。模型输出的 rubric_id 必须存在于当前 rubric 集合，
多余/虚构的 id 直接丢弃。JSON 解析失败重试 2 次，仍失败则该份简历走规则引擎。

### 决策五：技术栈选无构建步骤

Node 24 + Express 5 + 原生 HTML/CSS/JS（`public/`），`npm i && npm start` 单进程单端口启动。

被否方案：React + Vite（需 build 或双进程，现场多一个失败点）、纯静态页（无法真解析 PDF/DOCX）。
面试 Demo 第一优先级是现场一定能跑。

## 3. 架构与数据流

```
浏览器 public/
  ├─ JD 文本 ──POST /api/jd/parse──▶ pipeline/jd.js ──▶ llm(JD拆解) 或 规则兜底 ──▶ rubric[]
  │                                   （HR 可编辑 rubric / 权重 / 增删）
  ├─ 简历文件(multipart) ─POST /api/screen─▶ pipeline/match.js
  │                                            │
  │                                            ├─ resume-parse.js: pdfjs / mammoth / txt → rawText
  │                                            ├─ llm(简历抽取) → 结构化字段 + rawText 保留
  │                                            ├─ llm(逐条判定) ──▶ verdicts[]（并发 3）
  │                                            ├─ scoring/rules.js: 打分 + 结论 + 追问清单
  │                                            └─ store.js: 内存 + data/ 落盘
  ├─ 轮询 GET /api/run/:id ──▶ 进度与结果（不用 SSE，避免长连接现场故障）
  ├─ GET /api/candidate/:id ──▶ 详情：分数分解 / 条件矩阵 / 证据 / 追问 / 话术
  └─ GET /api/export/:runId.csv ──▶ CSV 导出
```

进程内并发用自实现的 `mapLimit`（限制 3），不做队列中间件——单文件演示无此必要。

## 4. 打分数学

```
item_score_i = weight_i × f(verdict_i)     f: met=1.0, partial=0.6, missing=0, unknown=0
confirmed    = Σ item_score_i / Σ weight_i        // 分母固定为全部 rubric 权重
coverage     = 1 − Σ(unknown 权重) / Σ(权重)
```

结论（按优先级短路，先判红线）：

```
if 命中任一 redline(违规)                    → 暂缓考虑（红线：…）
else if must 中 missing ≥ 2                  → 暂缓考虑
else if confirmed ≥ 0.75 && must 无 missing  → 建议进入人工复核
else if confirmed ≥ 0.50 || must missing ≤ 1 → 待定，建议补充信息后复评
else                                          → 暂缓考虑
```

分数展示为 `confirmed` 的百分制整数 + 独立的覆盖率条，**不把 coverage 混进总分**，避免"没写信息"和
"不符合"在视觉上被混同。

## 5. 模块边界

| 模块 | 职责 | 依赖 |
|---|---|---|
| `server/config.js` | 读 env，暴露 mode/model/并发/超时 | 无 |
| `server/llm/provider.js` | OpenAI 兼容调用、超时、重试、JSON 修复 | config |
| `server/llm/prompts.js` | 4 段 prompt 与 JSON schema 说明 | 无 |
| `server/pipeline/jd.js` | JD → rubric；规则兜底；rubric 规范化 | provider, prompts, rules |
| `server/pipeline/resume-parse.js` | 文件 → 文本（PDF/DOCX/TXT/MD），空文本报错 | pdfjs, mammoth |
| `server/pipeline/match.js` | 并发编排、证据校验、组装 candidate | provider, parse, rules, store |
| `server/scoring/rules.js` | 打分、结论、规则引擎、追问生成（纯函数） | 无 |
| `server/store.js` | run/candidate 存取（内存 + JSON 落盘） | fs |
| `server/index.js` | Express 路由、静态资源、错误处理 | 以上 |
| `public/*` | 单页 UI：三栏 + 详情抽屉 | fetch |

纯函数模块（`scoring/rules.js`）不 import 任何 IO，保证可单测。

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| 无 API Key | 全局规则模式，UI 角标提示，流程不中断 |
| 单份简历模型超时/JSON 坏 | 该份转规则引擎，结果标 `degraded: true`，不影响其他份 |
| 扫描件 PDF（无文本层） | 该份 `status: unparsed`，提示"疑似扫描件，需 OCR" |
| 文件过大 / 类型不符 | 前端拦截 + 后端 multer limits 双重校验 |
| 空 JD / 空简历 | 422 + 明确中文错误信息 |

## 7. 测试策略

`node --test test/`：打分公式边界（unknown 不给分、全 met=100、权重归一）、结论短路优先级（红线优先于
高分）、规则引擎同义词与年限抽取、简历文本抽取（用内置 PDF fixture）、证据校验函数。

不做端到端浏览器测试（成本收益不划算），改为 `scripts/selftest.mjs` 启动服务后对真实接口做一遍全链路
断言（含降级路径与 CSV 导出）。

## 8. 样例数据

`scripts/gen-samples.mjs` 用 pdfkit + 系统黑体（`C:\Windows\Fonts\simhei.ttf`）生成 10 份中文简历 PDF，
刻意覆盖：AI 工作流强匹配、学历红线、技能强但可实习时长未写（unknown）、转专业自学、全英文简历、
外贸业务跨界、扫描件（无文本层）、信息极简、站内消息式短文本、高匹配但期望地点不符（软红线）。

## 9. 合规边界

仅处理 HR 主动上传/粘贴的简历，不做平台抓取与自动沟通；样例数据全部虚构。README 与讲解稿中明确说明，
作为"能识别业务风险"的加分点。

## 10. 交付物

可运行 Demo（`npm i && npm start`）、10 份样例 PDF、单测、`scripts/selftest.mjs`、README（含架构图与
选型理由）、`docs/demo-script.md`（讲解稿 + 面试官追问预案）。
