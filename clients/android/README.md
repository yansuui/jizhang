# 记账 Android App：当前功能目录

**2026-11-06 native completion contract source recheck:** Only A020/A093/A113 and sections6.5/9.3/10/11.0/12.3 were rechecked. POST native-completions is additive backend/iOS capability; Android has no consumer, native result callback or continuation UI. Existing feature IDs, unrelated audit dates and historical totals remain. No Android product code, device/live-provider or deployment verification is claimed.


**2026-11-06 对话工作区契约局部复核：** 仅复核 A020/A093/A107–A116、§6.5/9.3/10/11.0 及抠图输入兼容性。服务端新增 `workspace-v1` 协商、权威分页选择、修改草案替代、确认后原任务续接、只读每日复盘和受信任原生入口目录。Android `AssistantRepository.createGeneration` 仍只发送 version/clientRequestId/input，未声明该能力；本轮没有新增 Android 工作区卡片、字段编辑、原生入口路由或每日通知。iOS 的新工作区和本地提醒不构成 Android 功能或设备验收证据。稳定 ID、其他章节日期、历史总数/测试记录均保留；源码依据及边界见[本轮目录维护交接](../../.trellis/tasks/11-04-ios-assistant/research/harness-android-inventory-handoff.md)。

**2026-11-06 助手执行可靠性局部源码复核：** 复核 A020/A093/A107/A115/A116 与 §6.5/9.3 的现有消费契约：服务端逐次保存成功读取的结果，历史整理启动/继续/状态查询返回任务后结束当轮对话，后台分析独立继续；模型不在同一轮反复轮询。扩充有界决策与参数纠错，保留写入预览、用户确认和账本隔离。Android 源码未修改，聊天仍没有独立任务观察卡及完整复杂结果页；A105–A106 的既有独立整理工作区继续使用原观察流程。仅推进上述条目的源码核对，其他审计日期、历史总数与设备验收状态不变；本轮证据见[可靠性审查记录](../../.trellis/tasks/11-04-ios-assistant/research/assistant-reliability-review.md)。

**2026-11-05 分配模板退役（服务端与 iOS 变更，Android 源码未改）：** 服务端停止把「分配模板」当作产品能力，新增迁移 022 把每个用户自建模板名折叠为同名账单标签（`template_tag_mappings` 仅作审计/回滚，`budget_templates`/`budget_allocations` 行一律保留，历史工资分配快照不受影响），预置的 `builtin-default-template` 刻意不折叠。`GET /api/v1/templates` 保持只读兼容并返回弃用标记；创建、编辑、删除、设置默认和应用当前周期均返回 410。Android 源码仍保留 M02.01–M02.07 的入口和按钮，但这些写入不再可用，需要后续客户端适配。助理侧 `templates.read`/`template.create`/`template.update`/`template.default`/`template.delete` 已从工具白名单移除（A114 见下），历史整理卡片不再产生 `templateProposals`（A105/A106 见下），因此 §6.1 的“AI 还生成了 N 个预算模板建议”分支在服务端恒为 0、不会显示。同日修复 assistant 历史整理第二次回复必然失败的缺陷：`spending.preview`/`spending.resume` 改为后台启动并立即返回 `run`，需用 `spending.status` 轮询进度、`spending.card` 读取建议；此前它会 await 整段分批次分析，撞上单次生成 180 秒硬上限。**本节只记录服务端契约与 Android 的既有消费路径，Android 源码未修改、未重新编译、未真机验证；iOS 为本次主开发端。**

**2026-11-05 助手业务工具局部源码复核：** 核对 A020/A021/A024、A072/A073/A077/A084/A087，新增 A107–A116 业务能力组，更新 §6.3/6.5、§9.3/10 的服务端工具及 Android 通用卡边界。工具沿用既有 v1 消息、确认卡、结果与 confirm/cancel 接口；本次没有新增 Android 页面或 HTTP 路由。Android 不按工具名限制通用卡确认，但复杂结果摘要、聊天中逐项选择和成功后的跨页面刷新仍有缺口，详见下文。这里只记录源码与契约核对；自动化门禁由本轮任务另行记录，不代表已接真实 Provider、真机安装或生产部署。其他章节审计日期和历史统计不变。

**2026-11-05 多用户局部源码复核：** 仅复核认证/注册/邀请管理 P003–P013、P020/P031/P033、新增 P042–P045，以及 D023–D025 的个人备份边界和 A041/A056/A060 的账号所有权；其余章节审计日期不变。新增注册、身份解码、公开认证 Cookie、邀请码字段和稳定 ID 隔离的 JVM 测试源码。本机 Gradle 尝试因分发包独占锁等待超时而未进入测试，且未发现 Android SDK；本轮编译/测试/lint 以 GitHub CI 结果单独记录，**没有真机验收或部署证据**。

> 源码核对日期：**2026-10-10**；导航/主题/首页/账单增补核对：**2026-10-10（本轮 UI 重构）**；多文件账单融合导入与边界修复核对：**2026-10-17**；**品牌、首页真实余额与记账交互优化核对：2026-10-22**；**AI 智能整理旧账 Android 接入核对：2026-10-22；超时断点继续及整理卡片账单详情专项核对：2026-10-23**；**C1核心导航与记账表单局部复核：2026-10-30**（仅P017–P020、L00/L01/L04相关条目、A001与主Kotlin目录；未推进全库未修改章节）；**核心财务修复轮复核：2026-11-01**（仅T01–T12 受影响条目：D006/D009/D014/D015、P017、A001/A005/A015/A022/A023/A025/A026/A028/A030/A031/A104、B03.08–B03.13、S01.02/S01.08/S01.10/S01.12、B02.12 及主 Kotlin 目录；未推进全库未修改章节）。维护对象是当前工作区（包含未提交的 UI 改动与边界修复），不是仅以 Git HEAD 或旧设计稿为基准。本文记录“目前有什么、怎样输入和操作、接口及限制是什么”，作为后续 UI 重做、功能验收和维护的事实基线。

**2026-11-01 自动化门禁（本工作区实测）：** `:app:testDebugUnitTest` 62 套/570 项全通过（0 失败 0 跳过）；`:app:lintDebug` 0 错误/43 警告；`:app:assembleDebug` 成功（APK 23,122,366 字节，SHA-256 `7FEC23EE14415B3EDF3F76B0E01D114E414FFCD81665CE32632CDA8649785EEC`）。**未部署、未真机安装**；触摸/IME/SAF/弱网/无障碍/系统返回等设备证据全部保持待验。

**2026-10-29 局部源码说明校正：** 仅复核首页 `L01.03` 的缺失金额回退及平台导入 `D022` 的退款状态处理，纠正文档描述；未改变功能或推进其他章节的审计日期，未新增设备或生产验证。

**2026-10-22 品牌与记账交互专项：** 应用更名“Yansuu1记账”；设置与外观提供六款桌面图标切换（默认第6款橙色），经由 `activity-alias` 实现动态切换并保留 MainActivity 组件身份；首页移除月份下拉并固定展示当前月，彻底移除伪造的微信/银行卡分摊并按服务端 `balances.items` 动态展示全部真实账户（含0/负值/多账户），支持一键全遮罩与独立失败重试；账单详情采用居中精美悬浮卡片 Dialog 呈现（四边留白、顶部标题及关闭✕、中间大图标与分类金额 Hero、紧凑属性列表、底部胶囊编辑/退款/删除按钮），关闭/返回保留来源列表筛选/页码/滚动，对支出账单提供“记录退款”直接关联原支出且不改原记录；记账页面固定金额与数字键盘（同时可见）、元数据独立滚动、输入备注/标签时自动隐藏键盘避让输入法、错误移至顶部浮动展示4.5秒，统一顶底保存为防重入单次提交。本地测试 19 suites / 215 tests 全通过，lintDebug 0 error，本地最新 Debug APK 大小 22,206,206 字节，SHA-256 `ce2356671fe4d2dda4c55dbcf0b265251369100858f208a8900cdbfc1451486b`；设备端待验。

**2026-10-22 账户切换专项：** 账单页月份栏下方新增常驻“全部账户 / 单账户”选择，复用既有 API，切换保留其他已应用条件并回第1页；历史账户可查，账户元数据独立加载，列表按完整查询与代次隔离。核对范围仅 §2 账单入口、§4.3 L02、§4.13/§11.0 对应 API、§9.1/L-GAP07、§11.1 新辅助文件及 §12.3，不推进其他章节审计日期。源码/本地验证与设备验收分开；本次没有部署或装机，最终本地结果见[本任务记录](../../.trellis/tasks/10-22-bill-account-switch/implementation-status.md)。

**2026-10-27 用户反馈修复补充：** B03.08–09/B03.11：已在旧 APK 真机复现透明 Scenario 拦截执行页点击/信封页滑动；改为只放置当前 Tab，保留三份 composition。补齐独立刷新反馈、退款失败重试与确认周期/修订的只读历史入口。旧测算在手机仍有 r3 保存记录，但原合同只保留最新一份；不自动转成执行周期。最终本地 42 suites / 454 tests 全过，lint 0 errors / 43 warnings，Debug 构建成功；22,795,658 字节，SHA256 `0E14D45AAF134835E3D38F5A89B0E4FF59092DAE701A80E956C83B8C2A143244`。SDK adb 覆盖安装 Success；手机锁屏阻挡修复后交互验收，待解锁，不宣称点击/滑动已设备通过。详见[专项记录](../../.trellis/tasks/10-27-financial-execution-phase1/followup-ui-repair.md)。

**2026-10-27 四用途理财执行系统第一阶段（工资周期、用途映射与退款净执行）：** 首页与预算统一为“预算与理财规划”二级宿主页（三段 Tab：四用途执行、分类信封预算、测算预估），触控区 ≥48dp，常驻 compose 避免切 Tab 丢失草稿，统一 BackHandler 守卫；首页卡片支持一键平滑切换“分类信封”与“四用途执行”，按 serverBaseUrl + username 维度持久化至 `FinancialPrefs`；四用途执行工作区接入服务端 `/api/v1/financial-planning`，基于 WorkOwner 代次票据与认证作用域安全读取与重放；必要开支（50%）与随心消费（10%）展示实际毛额、退款扣减、净支出与剩余，成长（25%）与应急（15%）诚实标注文案“未接入实际划拨”，提供分类信封对照参考卡片与差额提示；独立规划设置弹窗支持基点比例（sum=10000 bps）、必要基准、目标月数与周期时区修改，带 CAS 与操作重放；独立分类映射弹窗支持继承/明确不归类/必要/随心四状态与拓扑 Token CAS；退款拆分弹窗支持多原单精确分摊；新建工资增加 `operationId` 幂等透传与确认弹窗；支出账单增加可选 `financialPurpose`（`essentials`/`joy`/`null` 清除）原子提交与重放。本地自动化测试 437 项全通过（新增 89 项理财执行与重放测试），lintDebug 0 error / 43 warnings，Debug APK 大小 22,716,138 字节，SHA-256 `E9082E85CEB1B11363F7746E57E6BA9B78E5C5AF3FEF23E0EB887368768E801C`；真机设备交互与生产服务部署待验。

**2026-10-26 四账户理财计划：** 预算页新增独立B03入口，手填税后月收入/实际必要开支/当前备用金，固定25/15/50/10服务端试算；应急目标=实际必要开支×5，显示缺口/进度/月数及12个月无收益假设预测。保存一份服务器当前方案，备用金实际值手动更新；不改账单/工资/账户/预算，不调用AI，不自动转账/投资。场景提示与教育说明仅在页内，无系统通知。源码/本地验证，不等于真机验收；配套后端尚未部署。

**2026-10-26 AI配置模型拉取与搜索选择：** “我的 → AI接口设置”或AI助手更多菜单进入；保存接口地址/密钥后点“拉取模型”，服务器读取已保存配置做metadata GET，不发起AI对话。可搜索/点击模型ID填入草稿，需另点保存生效；保留手填和常用模型，失败/空列表不改当前模型。支持标准Chat/Responses，custom手填；首次可关闭AI、空模型保存后拉取。核对A041/A056/A060及新增POST /ai/models，稳定ID不新增；未接真实Provider/未真机安装。

**2026-10-26 首页/标签/统计三项修正：** 删除首页正文最下方重复“记一笔”，底栏中央＋保留；首页总余额下方恢复“统计分析”卡片，复用现有统计图页且不依赖首页数据加载成功；记账“选择已有标签（可多选）”支持搜索、勾选/取消，复用GET /tags按活跃账单使用记录列出名称，可继续手动新增，加载失败独立重试不清空草稿。只核对L01.04/L01.07/L04.06与相关入口/API，不推进无关章节审计；无后端/统计口径变化，真机交互待验。

**2026-10-26 金额键盘恢复专项：** 修复先用系统输入法填写备注/标签后无法重新唤出金额数字键盘：金额卡片支持点击，清除文本焦点并隐藏系统输入法，按真实焦点回调恢复数字键盘；空金额与紧凑布局同样可切回，不清空备注、标签或金额。核对范围仅L04.03/L04.06及本次日志；不推进全库审计日期，不改后端、金额计算、保存或AI配置。设备IME/反复切换待验。

**2026-10-23 整理卡片查看原账单：** 分类、标签及备注建议卡片支持点击，直接复用现有居中账单详情弹窗；显示当前原账单的备注、分类、账户、日期、金额与既有退款关联信息。复选框只负责勾选，卡片正文只负责查看；关闭后保留审核列表与已选项。整理入口为只读详情，不显示编辑/退款/删除，原账单页保持原操作。不新增接口、不触发AI分析；源码连线测试不等于真机触摸验收，设备验证待完成。

**2026-10-22 AI 智能整理旧账专项：** AI 助手新增独立“智能整理旧账”入口（欢迎卡和更多菜单）。用户选择本月、上月、近3个月、今年或自定义起止日期；服务端按本地日历完整分析范围内账单，单次上限 500 笔，超过上限明确拒绝并提示缩小范围，不截断、不显示部分结果。分析完成后进入逐笔审查：分类前后值、标签前后值、账单日期/金额/收支类型、AI 理由与置信度；备注建议和新建分类建议只展示不自动应用，预算模板建议也不在本次工作区应用。分类/标签动作默认最多选中 100 项，一次明确确认应用；成功后显示操作编号并可条件撤销，撤销冲突时不部分恢复。原备注、金额、账户、日期、退款事实均不修改。Android 通过 `OrganizationRepository` 接入专用 `organization-runs` / `organization-operations` 路由，支持 `background: true` 与 `clientRequestId` 异步启动，15分钟有界观察展示真实阶段、批次、处理数、建议数与事件时间线，失败给出结构字段诊断；请求代次与服务地址隔离；页面实现见 §6.1 A105–A106。**证据等级：源码与本地自动化验证；未连接真实 Provider、未部署生产、未在物理设备安装实测。**

**前序导入实现状态（以下保留历史验证记录，不作为账户切换本轮结果）：** 底部导航维持 4 个一级页面 + 中央记账动作（首页 / 账单 / ＋ / AI 助手 / 我的）；预算与统计为二级页；AI 聊天为一级入口。本轮多文件账单融合导入与边界修复闭环：支持 1–5 个账单文件多选融合导入（全局 ≤500 条）、两阶段 review-confirm 权威审核、ReviewSelectedRow 服务端 categoryType 与拟新建徽章逐行投影、空备注精准保留、ReviewSummary.counts 独立解析 typed counts 并分离 ruleIgnored 与 userExcluded、严格 BigDecimal 整型/长整型解析（2^63 边界 fail-close）、validateAndReduceBatchPages 5 页有界完整性校验与有界重试、严格非空 viewRevision 守卫、显式分类批准/改名入口（无新分类自动批准）；生产解码器适配真实 Fastify wire JSON 契约（reader identity 正式对齐 platform_order 与 occurrence 严格拒 unknown，34 行 wire fixture 初测 FAIL 修复后全量 PASS，null AI reason 不展示字面 "null"）。本地构建验证：`assembleDebug`、`testDebugUnitTest`（12 suites / 156 项全绿，Gradle XML 验证：基线 91 + 批次专项 65 项：NetworkContract 20 + State 45）、`lintDebug` 通过（0 errors / 9 warnings / 21 info，明确保留 9 baseline warnings 不宣称 0 warnings）；本地最新 Debug APK 大小 18,473,623 字节，SHA-256 `ec2ab9e55f8f78db2b84a5fd5884d413011f7fd5b05733bbebb921ce700deba0` 独立核验（明确核实未在物理设备安装实测；前序构建 153 tests / 19,580,136 字节 `0c956aac...`、`5c00...` 与 `09dc...` 保留为历史记录不可伪抹）；明确仅 local 源码与真实本地 Fastify wire 路由测试通过，生成 fixture 不等同于真实 Provider/真机已验证，绝不能称“真实线上协议已验证”；未部署线上生产，无设备安装，真实海量导出 benchmark 缺口保留，独立 review 处于最终读回中未全闭环，整体判定为 LOCAL VERIFIED / UNTESTED ON DEVICE & LIVE PROVIDER / PENDING FINAL READBACK。

**证据等级：源码审计与本地编译验证。** 本轮核实本地源码、Gradle 自动化测试及编译产物哈希，明确未在物理设备安装运行，未连接生产服务器或真实外部 AI 服务。下文“已接入”表示可找到实际 UI → Repository → API 路径，不能当作设备实测成功。Android API26 / 鸿蒙4、文件选择器、弱网、动画和真实账务流程都需要另行验收。

原全量审计统计为 **314个稳定功能条目（含新增A104）、30个助理工具、126个服务端API接口、51个main Kotlin文件、14个route文件**。314条包括工具条目，工具数不另加到总数。2026-10-22 品牌与记账交互优化未重算无关功能总数；新增图标控制器、真实余额解码、详情录入辅助、完整月份加载器及本轮 AI 智能整理 4 个 main Kotlin 文件后，当时统计为 **322 个稳定功能条目（A105–A106及新增B03.01–B03.06）、137 个服务端 API（含整理运行/模型列表及新增3个独立理财计划端点）、72 个 main Kotlin 文件、14 个 route 文件**。2026-10-30 C1–C3局部维护后主Kotlin路径实数为 **97**，T03 新增 ManualGoalInput.kt 后为 **98**，T04 新增 ManualGoalOperationReplay.kt 后为 **99**，T05 新增 ManualGoalProgressReadState.kt 后为 **100**；本轮未重新审计全库稳定条目/API总数，前述数字保留为历史统计，不当作最新总数。§11.1 仅表示目录覆盖，不代表全量源码逐行复审。

**维护方式：每次相关功能代码修改，同一批次更新本 README。** 这不是自动监控或定时更新服务。源文件或接口发生变化而文档未改，视为文档漂移。

原来的 [UI 重构设计](ui-redesign/README.md) 是设计提案，本目录是实际功能清单；S01–S48 或动画十二原则的设计内容不等于全部实现和验证完成。

## 目录

- [1. 产品范围与状态标记](#scope)
- [2. 导航与全部入口](#navigation)
- [3. 平台、会话、外观和设置](#platform)
- [4. 首页、账单、工资、预算、统计与主数据](#ledger)
- [5. 数据文件、物品、转账、回收站和周期](#operations)
- [6. AI 助理、Provider、工具和接口](#assistant)
- [7. 表单字段与操作速查](#forms)
- [8. 账务口径与数据边界](#accounting)
- [9. 已知问题与显示缺口](#gaps)
- [10. 没有接入或不存在的功能](#absent)
- [11. 源码和 API 覆盖](#coverage)
- [12. 维护流程、记录模板和变更日志](#maintenance)

<a id="scope"></a>
## 1. 产品范围与状态标记

这是 Kotlin / Jetpack Compose 单 Activity 记账客户端，连接自托管后端。多用户版本通过邀请码注册，每个账号拥有独立账本和 AI 配置；旧版服务器仍可登录，但不显示邀请管理。主要域包括账单、收入/工资、预算分配、账户余额、周期待确认、统计、主数据、转账、文件导入导出、物品持有成本和 AI 助理。金额传输/存储为整数分，页面格式化成元；普通页面金额通常无货币选择。

默认 API 服务地址为 `https://jz.yansuu1.xyz`，请求前缀 `/api/v1`。仓库中的 Web 工程已退役并移除；当前服务端目标为 API-only，但仓库变更不证明生产服务已升级。Android 实现以本目录所列源码与验证证据为准。

| 标记 | 含义 |
|---|---|
| **直接 UI** | Android 有页面、按钮或字段和实际 API 调用 |
| **间接工具** | 可由助理白名单工具调用，但没有同等完整独立 UI；模型选择与摘要展示存在限制 |
| **仅服务端** | API/service/CLI 已有能力，Android 没有入口或未调用 |
| **源码缺口** | 字段未展示、入口/限制不一致或代码行为与文案不符 |
| **设备未验** | 有源码证据，当前没有相应设备/服务运行证据；适用于全部功能条目 |

稳定 ID 前缀按审计域保留：P 平台；L00 导航、L01 首页、L02 列表、L03 详情、L04 编辑、L05 关联；B01 预算、B02 统计、S01 工资、M01 主数据、M02 模板，D 文件、I 物品、T 转账/回收站、R 周期、A AI。条目涉及多个操作时仍以同一个原审计 ID 追踪；引用 ID 不代表新增功能。

<a id="navigation"></a>
## 2. 导航与全部入口

证据：[MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt)、[MyTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/MyTab.kt)、[LoginScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/LoginScreen.kt)。

| 一级入口 | 页面/动作 | 可以继续进入 | 返回和限制 |
|---|---|---|---|
| 登录/冷启动 | 会话检查、用户名/密码登录 | 独立服务器地址页 | 地址页返回登录；验证过会话才进入主界面；标题使用统一应用名“Yansuu1记账” |
| 首页 | 问候、总余额 Hero（含真实账户行与遮罩）、本月收支、本月计划入口、统计入口、预算摘要、待确认提醒、最近账单 | 全部账单、最近账单详情卡片、全局＋记账、待确认、计划页、统计页 | 本月计划与统计卡位于主数据加载/失败分支之前；旧预算摘要不再作为第二个计划导航入口。详情覆盖呈现不卸载首页；记一笔/编辑全屏对话框，保存后就地刷新 |
| 账单 | 标题旁切月、右上刷新、账户选择、收支类型、名称或金额搜索（默认全部历史，可选所选月份）、自动分批加载、月份每日收支 | 详情卡片、编辑、删除；新建走中央＋ | 点击记录弹详情；搜索需服务端支持 searchVersion=1，旧服务端不会伪报搜索成功；高级筛选面板仍无入口（L02.03/L02.04） |
| ＋（记一笔） | 中央圆形动作，非驻留 Tab | 大金额/数字键盘、分类、默认今天与账户；备注/标签/理财用途收进“更多”，必要时因已有内容或退款预设展开 | 普通记录默认账户按服务端+认证用户记忆；账户失效改选首个活跃账户；退款固定沿用原账户，原账户不可用时明确报错而不静默切换。保存/取消返回来源；单次门控 |
| 计划 | 底部一级页面“计划”，默认本月计划摘要 | 消费预算/已确认消费/预算剩余（待核对时隐藏精确剩余）、必要/随心服务端合计、应急/成长预留参考、可展开分类明细；旧执行/信封结余池/测算为明细工具 | no-period/disabled/旧服务404/加载失败分别显示；工具返回摘要，退出恢复原来源；本地JVM/lint/assemble通过，设备待验 |
| 我的 | 分组功能中心 | “记账与计划”：工资/分类与账户/周期/待确认/转账/回收站/数据；“更多工具”：分配模板、物品、AI聊天与AI接口、桌面图标与外观及旧财务工具 | 更多工具不删除能力；AI由MainShell记录来源并返回；二级页隐藏底栏 |
| AI 助手 | “我的 → 更多工具”二级聊天 | 历史对话、附件、导入预览 | AI 页面隐藏底栏；关闭返回记录的来源页；草稿仍为进程内状态 |


| 我的分组 | 二级入口 | 主要功能 |
|---|---|---|
| 记账与计划 | 工资记录 | 历史、新增/编辑工资、分配确认 |
| 记账与计划 | 分类与账户 | 主数据新增、编辑、排序、删除与引用影响 |
| 更多工具 | 分配模板 | 新建/编辑模板、默认模板、应用到周期（低频配置） |
| 记账与计划 | 周期账单 | 五种频率、启停、编辑/删除 |
| 记账与计划 | 待确认账单 | 生成、逐笔核对确认或忽略 |
| 记账与计划 | 转账记录 | 账户间资金转移、分页、编辑、删除 |
| 记账与计划 | 回收站 | 账单恢复、永久删除、全部恢复/清空 |
| 记账与计划 | 数据管理 | 4类CSV导出、2类CSV导入、平台导入、服务端备份 |
| 更多工具 | AI 助手 | 对话、历史、附件、导入预览；作为带来源返回的二级页打开 |
| 更多工具 | AI 接口设置 | Provider、认证、高级请求配置、测试保存配置 |
| 更多工具 | 物品资产 | 资料、购入/售出关联、持有成本、照片/抠图 |
| 更多工具 | 桌面图标与外观 | 主题、减少动态、桌面图标切换（6款）、周期日、密码、AI状态 |
| 更多工具 | 四用途理财明细 | 旧执行/信封/测算入口；仍保留访问，不代替底部“计划”默认入口 |

**返回边界：** 内层表单有自己的取消/系统返回策略；外层“返回我的”大多直接移除二级页，除工资外并不自动转交表单。页面内存草稿不等于跨进程持久化，不能假定所有表单都具有离开确认。

<a id="platform"></a>
## 3. 平台、会话、外观和设置

本节 P001–P045：直接 UI、本地基础设施及明确不存在的能力混合，按每项描述区分。

### 3.1 逐项功能

| ID | 功能与当前行为 | 主证据 |
|---|---|---|
| P001 | 原生 Kotlin/Compose 单 Activity APK；应用 ID `com.yansuu1.jizhang`，名称“Yansuu1记账”，minSdk26、target/compile34；支持 6 款桌面图标（默认第 6 款橙色，经 activity-alias 动态切换并保留 MainActivity 组件身份）；versionCode3，versionName读取根 package.json |[build.gradle.kts](app/build.gradle.kts)、[AndroidManifest.xml](app/src/main/AndroidManifest.xml)|
| P002 | Android 和支持 APK 的鸿蒙4是交付目标；Android8/API26和鸿蒙4的本轮设备兼容性没有证据；Harmony5/6 ArkTS代码属另一客户端 |[native-delivery.md](../../.trellis/spec/backend/native-delivery.md)、[build.gradle.kts](app/build.gradle.kts)|
| P003 | 自托管多用户独立账本，受邀注册；不共享账本/AI 密钥；无找回密码、客户端 PIN/指纹锁 |[LoginScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/LoginScreen.kt)、[RegistrationScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/RegistrationScreen.kt)|
| P004 | 原账号/管理员由服务端配置并保留原数据；新用户从登录页“邀请码注册”进入，向管理员获取邀请码 |[LoginScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/LoginScreen.kt)|
| P005 | 冷启动读取服务地址；有匹配会话才请求 auth/me，验证成功进入首页，期间显示检查状态 |[MainActivity.kt](app/src/main/java/com/yansuu1/jizhang/MainActivity.kt)、[LoginScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/LoginScreen.kt)|
| P006 | auth/me 请求有10秒 callTimeout，外层会话恢复12秒；失败保持登录界面，不凭旧用户名自动进入 |[ApiClient.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiClient.kt)、[LoginScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/LoginScreen.kt)|
| P007 | 用户名和密码登录；用户名trim；非空校验；密码可显示/隐藏；提交期间禁登录/注册/改地址及账号密码字段；错误文字反馈 |[LoginScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/LoginScreen.kt)|
| P008 | 默认服务器 `https://jz.yansuu1.xyz`；登录页显示当前地址，独立子页修改 |[LoginScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/LoginScreen.kt)、[ApiClient.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiClient.kt)|
| P009 | 地址要求 http(s) origin：禁止用户名/密码、非根路径、query和fragment；可含端口；去尾斜杠；不添加/api/v1 |[ApiClient.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiClient.kt)|
| P010 | “恢复默认地址”只先改编辑框；点击保存才持久化到DataStore；没有服务器连通性测试按钮 |[LoginScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/LoginScreen.kt)|
| P011 | 改变服务器/退出/新登录或注册推进代次；公开认证请求不携带旧 Cookie、不跟随重定向；成功验证响应及新 Cookie 后才替换保存会话。主界面按激活会话 key 重建；密码/邀请码不保存到DataStore |[ApiClient.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiClient.kt)、[ApiTransport.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiTransport.kt)、[AuthRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/AuthRepository.kt)|
| P012 | jizhang_session Cookie用SharedPreferences保存，匹配域/路径/过期/Secure，跨进程恢复；不是加密存储。读取真实 id/username/role/capabilities/expiresAt，验证到期时间；旧服务器缺少 id/权限可登录但不显示管理入口。无会话时长设置 |[AuthenticatedUser.kt](app/src/main/java/com/yansuu1/jizhang/net/AuthenticatedUser.kt)、[ApiClient.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiClient.kt)|
| P013 | 除 POST login/register 外，当前代次 HTTP401 触发全局sessionExpired并返回登录；晚到401/Set-Cookie不影响新账号。公开认证失败不清旧Cookie；未验证/失败响应不会保存新Cookie |[ApiTransport.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiTransport.kt)、[MainActivity.kt](app/src/main/java/com/yansuu1/jizhang/MainActivity.kt)|
| P014 | 请求统一添加变更头 `X-Requested-With: fetch`；空POST/PUT/PATCH无JSON Content-Type；API错误映射为status/code/message |[ApiClient.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiClient.kt)|
| P015 | 普通HTTP连接15秒、读取90秒；网络传输统一通过ApiTransport管理，支持挂起取消底层OkHttp Call并关闭响应；无HTTP响应缓存/Room业务缓存/离线写队列/离线同步 |[ApiClient.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiClient.kt)、[ApiTransport.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiTransport.kt)、[build.gradle.kts](app/build.gradle.kts)|
| P016 | 注释提及requireOnline但实际没有该函数/网络监控实现；断网主要由请求失败提示，不能宣称统一预先禁用写入 |[ApiClient.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiClient.kt)、全main源码rg核查|
| P017 | 4 个一级页面 + 中央记账动作：首页 / 账单 / ＋ / 计划 / 我的；外层底栏切换通过 `NavigationLeaveCoordinator` 咨询当前活跃层（如财务脏草稿、导入批次未决恢复与编辑状态），拒绝后保留当前页；AI 助手从“我的→更多工具”作为二级页打开；首页提供本月计划与统计入口 |[MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt)；[NavigationLeaveGuard.kt](app/src/main/java/com/yansuu1/jizhang/ui/NavigationLeaveGuard.kt)|
| P018 | 账单详情/新建/编辑、统计、工资、待确认、AI聊天及“我的”二级页隐藏底栏；一级“计划”保留底栏，退出恢复进入前的主页面；状态主要remember，非持久化Navigation页栈 |[MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt)、[MyTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/MyTab.kt)|
| P019 | 首页可跳全部账单、新账单、最近账单详情、待确认、本月计划、统计；计划为底部一级页面；“我的”分为记账与计划/更多工具，AI聊天从更多工具打开并返回“我的” |[MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt)、[MyTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/MyTab.kt)|
| P020 | “我的”保留记账与计划、更多工具两组及退出登录；只有服务端授予 manageInvitations 的管理员新增“账号管理→邀请码管理” |[MyTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/MyTab.kt)|
| P021 | 子页顶部/系统返回；工资内部处理未保存退出；不是所有表单都有脏草稿确认，不能将规划规则当全部实现 |[MyTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/MyTab.kt)、各表单源码|
| P022 | ~~首页详情→编辑导航缺口~~ 已修复（2026-10-10）：详情记录来源页，编辑统一路由到账单编辑分支并保留来源返回 |[MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt)|
| P023 | 浅色/深色/跟随系统三主题，即时切换，本地持久化；读取异常回系统默认；保存异常被吞，可能重启不保留 |[MainActivity.kt](app/src/main/java/com/yansuu1/jizhang/MainActivity.kt)、[MyTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/MyTab.kt)|
| P024 | 钛蓝/森林绿/极简黑白三配色，即时切换，有外观预览卡；财务语义配色保持独立 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)、[JizhangTheme.kt](app/src/main/java/com/yansuu1/jizhang/ui/theme/JizhangTheme.kt)|
| P025 | “减少动态效果”本地开关；与系统ValueAnimator.areAnimatorsEnabled()的关闭结果取OR；onResume刷新系统开关 |[MainActivity.kt](app/src/main/java/com/yansuu1/jizhang/MainActivity.kt)、[ThemePrefs.kt](app/src/main/java/com/yansuu1/jizhang/ui/ThemePrefs.kt)|
| P026 | MotionTokens默认press90/quick140/base220/slow320/stagger24毫秒，reduced全0；并非所有Material内置动画被统一控制 |[MotionTokens.kt](app/src/main/java/com/yansuu1/jizhang/ui/MotionTokens.kt)、[Buttons.kt](app/src/main/java/com/yansuu1/jizhang/ui/Buttons.kt)|
| P027 | 共享主/次按钮按下缩放0.98；减少动态不缩放；多页列表/展开/图表消费tokens；设计十二原则不是已全部验收的运行能力 |[Buttons.kt](app/src/main/java/com/yansuu1/jizhang/ui/Buttons.kt)、各ui源码|
| P028 | 设置显示服务器当前周期：null自然月或每月1–28日；自然月与1日区分；读取min/max约束网格，失败重试 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt) SettingsFull|
| P029 | 选择新起算日仅为草稿，改变后才可保存；读取失败不保存；保存确认服务端返回后显示成功，无金额本地重算 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)、[BudgetRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/BudgetRepository.kt)|
| P030 | 修改密码输入当前/新/确认，遮罩，不用rememberSaveable；校验当前非空、新非空和两次一致；后端至少8字符 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)、[auth.ts](../../packages/server/src/routes/auth.ts)、[password.ts](../../packages/server/src/services/password.ts)|
| P031 | 改密成功后服务端当前用户的会话作废，不影响其他用户；客户端清密码并退出；当前密码错误401也触发当前会话清理 |[AuthRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/AuthRepository.kt)、[auth.ts](../../packages/server/src/routes/auth.ts)|
| P032 | 设置只读AI配置状态：读取中/失败重试/未配置/已配置停用/启用；不显示明文密钥，也没有从这里直接跳AI设置按钮 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt) SettingsFull|
| P033 | “我的”显示已验证用户名；主页和设置页都可退出，网络注销失败也清本地Cookie并返回登录；切换账号重建主界面与草稿状态 |[MyTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/MyTab.kt)、[AuthRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/AuthRepository.kt)|
| P034 | 金额显示整数分转元两位小数；日期epoch ms按设备时区格式化；文本日期以yyyy-MM-dd解析，关闭宽松日历并要求全文消费，但没有固定补零位数的正则校验 |[format.kt](app/src/main/java/com/yansuu1/jizhang/ui/format.kt)|
| P035 | 设备时区与部署Asia/Shanghai可能不同；不宣称所有客户端显示/输入日期统一服务端时区 |[format.kt](app/src/main/java/com/yansuu1/jizhang/ui/format.kt)、部署合同|
| P036 | 只声明INTERNET/ACCESS_NETWORK_STATE；无相机权限/通知权限/生物识别权限；主应用allowBackup=false |[main Manifest](app/src/main/AndroidManifest.xml)|
| P037 | 系统选文件/创建文件入口，不是FileProvider分享；未发现推送、Widget、定时后台记账、系统分享接收、URL深链接入口 |Manifest、[DocumentFiles.kt](app/src/main/java/com/yansuu1/jizhang/ui/DocumentFiles.kt)、[DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt)|
| P038 | debug DemoActivity为非exported预览入口，不属于正常应用功能；debug网络策略独立，release未声明明文HTTP允许 |[debug Manifest](app/src/debug/AndroidManifest.xml)、[debug_network_security.xml](app/src/debug/res/xml/debug_network_security.xml)|
| P039 | 设置地址校验能接受HTTP不等于release在Android9+允许明文连接；生产使用HTTPS，保留此区别 |[ApiClient.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiClient.kt)、main/[debug Manifest](app/src/debug/AndroidManifest.xml)|
| P040 | 仓库服务端为API-only，非API路径不提供Web页面；本报告没有再次访问/部署服务器，不代表生产已升级 |[app.ts](../../packages/server/src/app.ts)、[native-delivery.md](../../.trellis/spec/backend/native-delivery.md)|
| P041 | 没有客户端数据库恢复、应用内更新/版本关于页、通用帮助页入口；release无本地正式签名材料时用debug签名 |[MyTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/MyTab.kt)、[build.gradle.kts](app/build.gradle.kts)|

| P042 | 登录页→邀请码注册：账号/密码/确认/邀请码；账号trim后3–64位ASCII字母数字_.-，密码8–128 UTF-16单元且确认一致，密码不trim，邀请码trim且非空；密码可见、忙时禁重复与返回；成功201及有效Cookie后登录，网络结果不明可返回普通登录 |[RegistrationScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/RegistrationScreen.kt)、[RegistrationDraft.kt](app/src/main/java/com/yansuu1/jizhang/repo/RegistrationDraft.kt)|
| P043 | 管理员“我的→邀请码管理”：创建固定单次/7天邀请码，仅本页显示一次明文并可复制；列表显示状态/创建/到期、主动刷新、撤销确认；无权限403清敏感展示，离页丢弃代码并取消请求；无批量/权限编辑器 |[InvitationManagementScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/InvitationManagementScreen.kt)、[InvitationRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/InvitationRepository.kt)|
| P044 | 财务未决请求、记账默认账户、首页偏好及AI导入恢复以服务地址+不可变用户ID隔离；旧服务器才回退用户名。新版使用独立存储命名空间，保留旧用户名未决记录但不自动归属/重放；“我的”发现旧记录时提示先核对账本后人工恢复 |[FinancialPrefs.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialPrefs.kt)、[AssistantBatchRecoveryStore.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchRecoveryStore.kt)|
| P045 | 登录/恢复读取的权限才用于显示入口；缺少/未知角色不默认管理员；管理员只管理邀请码，个人账本页面仍按当前会话访问，客户端不发送用户ID选择他人账本 |[AuthenticatedUser.kt](app/src/main/java/com/yansuu1/jizhang/net/AuthenticatedUser.kt)、[MyTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/MyTab.kt)|

### 3.2 API 覆盖

| API | 入口/状态 |
|---|---|
| GET /api/v1/auth/me | 冷启动会话恢复 |
| POST /api/v1/auth/login | 登录 |
| POST /api/v1/auth/register | 邀请码注册并建立会话 |
| GET/POST /api/v1/admin/invitations | 管理员列表/创建邀请码 |
| DELETE /api/v1/admin/invitations/:id | 管理员撤销邀请码 |
| POST /api/v1/auth/logout | 两处退出与改密成功后的本地清理 |
| POST /api/v1/auth/password | 设置修改密码 |
| GET /api/v1/health | 后端存在；登录没有测试服务器按钮 |
| GET /api/v1/settings | 设置预算周期读取（委托BudgetRepository） |
| PUT /api/v1/settings | 设置预算周期保存，cycleStartDay为null或服务端允许的整数 |

<a id="ledger"></a>
## 4. 首页、账单、工资、预算、统计与主数据

### 4.1 L00 导航与总览

| ID | 当前功能 / 输入 / 操作 | 源码证据 |
|---|---|---|
| L00.01 | 登录后默认首页；4 个一级页面 + 中央记账动作：首页、账单、＋、计划、我的。首页计划/统计为可用入口；AI 助手从更多工具作为二级页打开并记住来源。记一笔保存/取消返回来源。 |[MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt)、（以下 ui/ 均指上述 Android ui 目录）|
| L00.02 | 账单新增/编辑/只读详情、统计、工资流程、首页待确认、AI聊天及“我的”二级页隐藏底栏；一级计划页保留底栏，离开恢复原主页面。新账单保存/取消返回来源入口。 |[MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt)|
| L00.03 | 首页查看全部切到账单；最近记录打开详情；“本月计划”卡打开计划一级页；统计卡打开统计二级页；提醒卡打开 PendingTab；中央＋创建账单。预算摘要卡保留为非导航摘要。 |[MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt)、[DashboardTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DashboardTab.kt)|
| L00.04 | 计划宿主的“记工资”、我的工资记录以及“＋→收入→记工资”均进入既有 SalarySheet，不把工资写成普通交易；从收入表单打开工资时保留底层草稿并可返回。分配模板仍从我的工具页进入。 |[MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt)、[TransactionEditSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt)|
| L00.05 | 页面/筛选/草稿普遍使用 Compose `remember`，并非离线账本或持久化草稿；进入别的主分支后重新组合可丢失局部状态。 |[MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt)、[TransactionsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionsTab.kt)、[TransactionEditSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt)|

### 4.2 L01 首页

| ID | 当前能力与行为 | 证据 |
|---|---|---|
| L01.01 | 首页请求服务端当前月趋势（1个月），移除历史月份下拉菜单与循环；顶部问候 + 服务端月份副标题 + 显式刷新按钮（加载中禁用）；支持 refreshToken 就地静默刷新并保留滚动位置。 |[DashboardTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DashboardTab.kt)|
| L01.02 | 总余额 Hero 显示服务端 `totalBalanceCents`，标“所有账户”；下方动态展示服务端 `balances.items` 全部真实账户（包含 0 值、负值信用卡/负债标红、长名截断、同名不同 ID），彻底移除旧客户端微信/银行卡固定分摊。提供眼睛隐私开关一键遮蔽总额与所有账户金额。账户请求独立加载，失败提供独立“重试余额”入口，不阻断主模块。 |[DashboardTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DashboardTab.kt)、[DashboardBalancesHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/DashboardBalancesHelper.kt)|
| L01.03 | 收支概览显示服务端 `incomeCents`、`netExpenseCents` 与服务端月份标签；当前源码对缺失金额回退显示 `0.00`，不在客户端从5条列表累加，不能将该占位数字视为已成功取得的真实金额。 |[DashboardTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DashboardTab.kt)|
| L01.04 | 首页“本月计划”与“统计分析”常驻快捷卡位于主数据加载/失败分支之前，不依赖首页数据成功；本月计划进入底部计划页，统计分析复用完整统计页。旧本周期预算内容只作非导航摘要，避免第二个预算入口；无伪造迷你图。2026-10-30源码核对，设备未验。 |[DashboardTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DashboardTab.kt)|
| L01.05 | 首页依据每个模块已用/预算提示接近上限（≥80%）、超支（>100%），零预算且有支出也算超支；负结余池提示借用/透支。 |[DashboardTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DashboardTab.kt)|
| L01.06 | 首页每次 reload 调显式 POST recurring/generate 后 GET pending；只在 pendingCount>0 显示可点击提醒卡；提醒失败单独显示并可重试整个首页。 |[DashboardTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DashboardTab.kt)|
| L01.07 | 最近5笔显示标题（备注优先、否则分类）、日期/分类、收支符号与金额，可点开详情；空列表有提示；2026-10-26按要求移除首页正文底部重复“记一笔”，保留全局底栏中央＋与账单页新增入口。 |[DashboardTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DashboardTab.kt)|
| L01.08 | 首次加载显示进度，首次失败阻断正文且有重试；刷新时保留上次成功结果，进度和“保留上次结果”提示；刷新失败保持旧数据显示错误/重试。401交统一过期处理。 |[DashboardTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DashboardTab.kt)|

### 4.3 L02 月度账单列表与筛选

> 本节及相关 API/缺口于 **2026-11-01** 就账单搜索及相关加载、汇总源码局部重核；其他未变条目沿用先前核对日期，源码/本地验证不等于设备验收。本页按资金账户查看普通账单；月份范围展示当前筛选下每日支出/收入，全历史搜索不展示每日汇总，不展示账户余额/月度总汇总，不混入工资和转账。每日统计需部署配套 daily-summary 服务端接口，旧服务端普通月列表仍可加载但每日金额显示不可用；搜索则需要搜索协议版本支持。时区使用设备 IANA 名称，整点固定偏移规范化为等价 Etc/GMT；自定义非整点固定偏移ID尚不支持（命名 IANA 非整点时区支持），失败明确显示不可用。

| ID | 当前能力与行为 | 证据 |
|---|---|---|
| L02.01 | 默认本月；月份与左右箭头位于“账单”标题旁，右上刷新，新建走中央＋。月份区间为设备本地月初00:00到下月初（右开）；搜索可选全部历史，无自定义范围。 |[TransactionsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionsTab.kt)|
| L02.02 | 支出/收入/全部类型 chip 即时更新；退款收入属于收入筛选。切月/类型/账户/分类/标签/搜索均重置第1页；列表按日期分组展示。 |[TransactionsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionsTab.kt)|
| L02.03 | 常驻“搜索名称或金额”输入框与搜索按钮，提交时 trim；非空搜索默认全部历史，可切换所选月份，与账户及类型组合；清除搜索回原月份。使用新 `search` 参数，不使用旧 `q`；配套服务端负责按备注/分类/账户/标签/元金额字面包含匹配。每页含空结果均要求顶层 `searchVersion=1` 和有效64位十六进制 `searchRevision`，跨页快照须相同；版本不支持或快照缺失/变化时拒绝成功并提示刷新。 |[TransactionsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionsTab.kt)、[transaction-service.ts](../../packages/server/src/services/transaction-service.ts)|
| L02.04 | 标题栏下方常驻账户下拉框（移除独立“账户”标签）：默认“全部账户”，按具体资金账户 ID 单选，选择后立即刷新当前范围，保留月份/收支类型及其他已应用条件；不依赖高级筛选面板。旧账户/分类/标签草稿面板代码仍在（应用才提交，关闭不提交），**当前没有打开入口**；本次不恢复无关入口。 |[TransactionsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionsTab.kt)、[TransactionQueryHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionQueryHelper.kt)|
| L02.05 | 活跃筛选为可单独清除 chip；整体“清除”清账户/分类/标签/搜索并回月视图，**不清月份和收支类型**；筛选数量只计账户/分类/标签。 |[TransactionsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionsTab.kt)|
| L02.06 | 历史分类/账户名称经 includeDeleted=true 获取，已删除账户仍可选择查询其有效历史账单；账户 DTO 不带删除标记，不做“已删除”分组/徽章，缺失名称提示信息暂不可用并保留条件。账户请求独立于账单和分类/标签加载，失败可重试且保留先前选项；标签来自当前活跃账单派生列表，分类查询是 exact categoryId、不含子分类（分类/标签面板入口当前缺失）。 |[TransactionsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionsTab.kt)、[TransactionQueryHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionQueryHelper.kt)、[transaction-service.ts](../../packages/server/src/services/transaction-service.ts)|
| L02.07 | 页码/上一页/下一页控件已移除（保留此ID）；月视图及搜索按最大500笔自动分批读取、显示服务端总笔数。总数变化/重复ID/空缺页/超过客户端100000笔安全上限明确失败，不把部分列表当完整结果；配套服务端另对非空搜索限制最多10000笔及结果交易行可变文本合计最多16 MiB（UTF-8字节；恰好边界可用），超限返回400 VALIDATION 并提示“搜索结果过多或文本过大，请缩小月份、账户或关键词范围后重试。”，不返回部分结果；无搜索不受此新限制。所选月每日展示服务端同筛选支出/收入；搜索月汇总也必须验证 `searchVersion=1` 及与列表相同的 `searchRevision`；月搜索先核验摘要再发布列表；快照变化、摘要协议错误或搜索摘要400时清空列表和条数并显示错误；普通网络或非400接口失败时可发布已验证列表、标记统计不可用而不本地加总。普通非搜索月份继续先发布列表，摘要失败或日期笔数不符只标记统计不可用。全部历史按含年份的日期分组，不请求或展示每日汇总，切月不改变历史搜索范围；不含工资/转账。 |[TransactionsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionsTab.kt)、[transaction-service.ts](../../packages/server/src/services/transaction-service.ts)|
| L02.08 | 卡片正文点开只读详情；右侧更多菜单有编辑与删除。显示备注、分类、账户、日期、金额、支出/收入/退款收入徽标、每个标签。 |[TransactionsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionsTab.kt)|
| L02.09 | 删除有确认（说明可去回收站恢复），提交时按钮禁用/删除中；失败留对话框错误；成功软删除后刷新。 |[TransactionsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionsTab.kt)|
| L02.10 | 首次加载、加载失败重试、无账单“开始记账”、无筛选结果“清除筛选”。切账户/月/类型/条件后立即隔离旧账单、条数与每日统计；仅完全相同的非月搜索查询刷新可保留明确提示的上次结果；月搜索刷新先隐藏旧行。完整分批列表与每日统计使用同一请求代次，旧成功/错误/结束状态不覆盖最新选择；普通统计网络失败不阻断已完整读取的列表；月搜索摘要400或契约失败阻断结果，401仍统一退出。 |[TransactionsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionsTab.kt)、[TransactionQueryHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionQueryHelper.kt)|

### 4.4 L03 只读账单详情

| ID | 当前能力与行为 | 证据 |
|---|---|---|
| L03.01 | 采用居中悬浮卡片 Dialog 呈现，关闭保留来源列表筛选与滚动；从详情启动编辑或记录退款，编辑/退款表单取消后回到原详情，保存后重新读取该详情并保留原来源。显示支出/收入/退款收入、分类、账户、日期、备注标签；独立所有权 ticket 防过期响应覆盖。该路由已做源码/JVM检查，设备返回/滚动待验。 |[TransactionDetailScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionDetailScreen.kt)、[TransactionDetailLoadOwner.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionDetailLoadOwner.kt)、[MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt)|
| L03.02 | 顶部“关闭（✕）”与底部操作栏；“编辑”与“记录退款”使用全屏账单编辑器，并分别保存/取消后返回原详情；退款带入原支出 ID、关联并保留原账户，不改原支出。删除需二次确认后移入回收站。 |[TransactionDetailScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionDetailScreen.kt)、[MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt)|
| L03.03 | 退款收入逐个 getTransaction(refundLinkedTxIds)，显示原支出标题、日期、金额；失败/未关联时显示“未读取到关联账单详情，关系仍保留”；关联行仅文字，没有点击跳转。 |[TransactionDetailScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionDetailScreen.kt)|
| L03.04 | 首次进度、错误信息、重试；已读到交易时可同时显示交易和后续错误/更新中。2026-10-23：A105 分类/标签/备注建议卡片复用同一详情 Dialog，只读模式隐藏全部编辑/退款/删除入口；点外部/关闭/返回仅关详情，不重置整理勾选或滚动。 |[TransactionDetailScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionDetailScreen.kt)|
| L03.05 | 后端原支出详情提供refundSummary及refundDetails，当前列表/详情均未读取这些字段，故目前无法从原支出查看已退款总数、金额及退款明细。 |[transaction-service.ts](../../packages/server/src/services/transaction-service.ts) 对照 [TransactionDetailScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionDetailScreen.kt)|

### 4.5 L04 新增与编辑账单

| ID | 当前能力与行为 | 证据 |
|---|---|---|
| L04.01 | 新建默认支出、当日、第一可用支出分类；普通记账优先使用按 `serverBaseUrl + immutable user ID (legacy server: username)` 隔离的上次账户，失效/不可读时回退第一活跃账户，无活跃账户显示阻断提示；支持 `refundOriginalId` 退款预填（自动标记退款、关联原支出、金额留空、日期今天、必须保留原账户，原账户失效时不静默切换而提示用户显式选择）。seed 在 baseline 之前应用；编辑与退款互斥。 |[TransactionEditSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt)、[TransactionRefundSeedHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionRefundSeedHelper.kt)、[RecordingDefaults.kt](app/src/main/java/com/yansuu1/jizhang/ui/RecordingDefaults.kt)|
| L04.02 | 支出/收入切换选择该类型首个可选子分类（跳过父分类）；收入类型额外提供“记工资”入口，打开既有工资流程而非写入普通transactions，并在工资页关闭后返回且保留收入草稿。切回支出关闭isRefund，退款关联文本可留在内存但支出保存发送空数组。 |[TransactionEditSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt)、[MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt)|
| L04.03 | 金额区（32sp 等宽大字）与自定义数字键盘（1-9, ., 0, 退格）固定展示，元数据（分类/账户/日期/备注/标签/退款关联）独立滚动；备注/标签获得焦点时隐藏自定义键盘避让输入法，金额与保存按钮始终可见；2026-10-26修复：整个金额卡片可点击，强制清除备注/标签真实焦点并收起系统输入法，恢复自定义数字键盘；金额为空、先输入备注/标签、系统输入法已收起但文本仍有焦点均可通过点击金额返回，不清空任何草稿字段；紧凑模式也显示切换提示。小屏/大字自动进入紧凑回退模式。仅追加数字/单小数点/删除；parseYuanToCents使用Double+Math.round，拒绝非有限、负数和>JS安全整数分；保存要求大于0；不支持计算器表达式。 |[TransactionEditSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt)|
| L04.04 | 分类网格按收支类型展示子分类、可选；有子类的支出父分类展示但不可选并提示“父分类不能直接记账”（服务端拒绝父分类记账）。账户列表选择；旧ID不在可用列表时显示已选项目暂不可用且保留ID，服务端决定可保存性；没有可用项时提示先添加。 |[TransactionEditSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt)|
| L04.05 | 日期支持文本和Material DatePicker，确认应用、取消不改；DatePicker用UTC转换确保日期显示，API保存用设备本地日期解析；parseDateInput不宽松且需解析完整文本，但没有固定宽度YYYY-MM-DD正则。服务端日期须≥2000-01-01且不超过服务器当前时间+1天。 |[TransactionEditSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt)、[format.kt](app/src/main/java/com/yansuu1/jizhang/ui/format.kt)、[transaction-service.ts](../../packages/server/src/services/transaction-service.ts)|
| L04.06 | 备注与标签收进默认折叠的“更多”区；新建时不展开，编辑中已有备注/标签/用途或退款种子时自动展开。折叠仅控制可见性，不清空草稿；展开后的备注为单行（IME避让），点金额可切回数字键盘。标签可手动输入或点“选择已有标签（可多选）”弹出可搜索列表，GET /tags读取，选择只更新草稿、保存前不写入；现有去重/长度/数量限制不变。源码与JVM检查通过，真机IME待验。 |[TransactionEditSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt)、[tags.ts](../../packages/server/src/services/tags.ts)|
| L04.07 | 仅收入提供退款标记；标记后可多选原支出，原支出不被改写；非退款收入/支出保存均强制空refundLinkedTxIds。服务端允许退款不关联任何原支出；不验证退款金额≤原支出金额。 |[TransactionEditSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt)、[transaction-service.ts](../../packages/server/src/services/transaction-service.ts)|
| L04.08 | 统一顶部与底部保存按钮为单次同步门控提交函数 `submit()`，保存中拦截重复点击防双写；表单校验失败与保存错误在顶部浮层显示（默认 4500ms，同文新事件重置，支持手动 ✕ 关闭与无障碍推荐延时延长）；保存成功触发父级刷新令牌就地刷新来源数据。 |[TransactionEditSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt)、[TransactionEditorHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditorHelper.kt)、[TransactionTopErrorHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionTopErrorHelper.kt)|
| L04.09 | 取消和系统返回统一requestClose；加载后与baseline比较所有账单字段/关联，修改后提示放弃修改/继续编辑；saving时拦截离开。草稿不持久化。 |[TransactionEditSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt)|
| L04.10 | 固定金额/键盘/保存；滚动区顺序为收支类型、分类、账户/日期、“更多”（备注/标签/用途，折叠状态仅影响显示），收入退款关联仍独立显示。折叠时若备注/标签拥有焦点会先收起输入法但保留值；小屏/IME遮挡仍待设备验收。 |[TransactionEditSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt)|
| L04.11 | Android 支出表单“更多”仅提供旧 `financialPurpose`（`essentials` / `joy` / `null` 显式清除）；已有用途编辑时自动展开。旧用途变更携带 `operationId`、`expectedFinancialPurposeRevision` 和 `expectedTransactionToken`，未改用途则省略。服务端另支持四值 `fundPurpose`，但当前 Android 不读取/编辑四用途或发送 `expectedFundPurposeRevision`；在服务端已有显式 canonical 用途后，旧客户端再提交旧用途字段缺少该 CAS 会获 409，不能当成已适配四用途。 |[TransactionEditorHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditorHelper.kt)、[TransactionEditSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt)、[TransactionEditorStateHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditorStateHelper.kt)、[transaction-service.ts](../../packages/server/src/services/transaction-service.ts)|

### 4.6 L05 关联账单选择器（退款/物品复用）

| ID | 当前能力与行为 | 证据 |
|---|---|---|
| L05.01 | 由type限定支出或收入，仅按type查询全时段，分页50笔，不支持月份/搜索/账户/标签筛选。打开默认回第1页；显示备注/日期/金额。 |[LedgerLinkPicker.kt](app/src/main/java/com/yansuu1/jizhang/ui/LedgerLinkPicker.kt)|
| L05.02 | 多选：独立draftSelected，确认后提交；取消/关闭丢弃本次选择。单选点行立即提交并关闭；“不关联”立即清空并关闭。 |[LedgerLinkPicker.kt](app/src/main/java/com/yansuu1/jizhang/ui/LedgerLinkPicker.kt)|
| L05.03 | 显示已选数量和已选记录，跨页选中不丢；未缓存的已选ID逐条取详情；查不到保留ID显示不可用并可移除；当用户确认移除才修改关联。 |[LedgerLinkPicker.kt](app/src/main/java/com/yansuu1/jizhang/ui/LedgerLinkPicker.kt)|
| L05.04 | 首次加载/失败重试/空列表；有列表时更新失败保留旧列表；401回调或展示重新登录提示。当前行提示“可从详情跳转核对”未代表选择器本身有详情导航能力。 |[LedgerLinkPicker.kt](app/src/main/java/com/yansuu1/jizhang/ui/LedgerLinkPicker.kt)|

### 4.7 B01 预算

| ID | 当前能力与行为 | 证据 |
|---|---|---|
| B01.01 | GET periods + overview；默认当前周期。当周期数>1显示横向chip（当前+历史），保留服务端顺序；历史显式只读，显示起始日。未知periodStart服务端返回400，不回退当前。 |[BudgetTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/BudgetTab.kt)、[budget-overview-service.ts](../../packages/server/src/services/budget-overview-service.ts)|
| B01.02 | 有预算显示服务端总预算、已用、结余池（负值标示）；无预算有第一笔工资按钮。`hasBudget`实际是服务端modules非空，不可解读成“有当月工资”的严格判定。 |[BudgetTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/BudgetTab.kt)、[budget-overview-service.ts](../../packages/server/src/services/budget-overview-service.ts)|
| B01.03 | 模块显示父级名称、预算、已用、剩余、封顶进度、未封顶已用百分比；状态正常/将超支（≥80%）/已超支（>100%）/零预算/零预算已超支；不能直接编辑模块额度。 |[BudgetTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/BudgetTab.kt)|
| B01.04 | 模块有children时可展开/收起子分类支出，服务端返回儿童金额。一次仅一个expandedModuleId；切周期清展开。不会跳到账单筛选页。 |[BudgetTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/BudgetTab.kt)|
| B01.05 | 工资与分配卡有模板入口与工资入口；预算另读pending数，有待确认时仅文字提醒，**无点击处理入口**，需首页/我的处理。 |[BudgetTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/BudgetTab.kt)|
| B01.06 | 首次加载、错误重试；切周期失败保持上次成功周期和金额，明确历史/当前标签；提醒失败可单独提示但重试实际reload预算及提醒；无常驻刷新按钮。 |[BudgetTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/BudgetTab.kt)|
| B01.07 | 预算进度由MotionTokens驱动，金额直接显示不动画计数；减少动态时token为0（策略见其他研究）。 |[BudgetTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/BudgetTab.kt)|

### 4.7.1 B03 四账户理财计划（独立用途规划）

本节 B03.01–06 保留 2026-10-26 核对记录；B03.08–09、B03.11 于 2026-10-27 用户反馈修复中重新核对，验证结果见文末专项记录。四账户指四种用途，不会自动创建银行账户或执行转账；独立手动「测算预估」只保存最新一份输入，不保留此前被覆盖的版本；工资周期「四用途执行」则仅在明确确认后生成周期与追加修订，二者不自动转换。已有服务端 API 不代表手机端交互已验收。

| ID | 当前能力与行为 | 证据 |
|---|---|---|
| B03.01 | 旧独立手动理财测算保留为“计划→明细工具→测算预估”，不再与本月计划并列为默认入口；无AI依赖，历史输入不自动转为真实储备或执行周期 |[FinancialPlanScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialPlanScreen.kt)、[FinancialHostScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialHostScreen.kt)|
| B03.02 | 三项手动输入：税后月收入>0、实际必要月开支>0、当前应急备用金≥0；元金额最多2位小数，精确整数分且不超过JS安全整数；先读后存，保存一份当前计划/最新手动金额；显式试算不保存，显式保存用revision防覆盖；失败保留草稿，未知结果重试同一请求，冲突需重新核对 | [FinancialPlanState.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialPlanState.kt)、[FinancialPlanRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/FinancialPlanRepository.kt) |
| B03.03 | 固定成长25%/应急15%/必要50%/快乐10%；服务端共享整数分最大余数法计算，四项非负且合计等于计划收入；不改工资、账户、账单、转账、分类、模板、预算快照，不自动购买投资 | [FinancialPlanModels.kt](app/src/main/java/com/yansuu1/jizhang/repo/FinancialPlanModels.kt)、[financial-plan.ts](../../packages/shared/src/financial-plan.ts) |
| B03.04 | 应急目标=用户实际必要月开支×5，展示手动确认储备、目标、缺口、超额、封顶进度及估计月数；已达标为0个月，月储备取整为0时无法估算；超目标金额不截掉；更新只存当前手动快照，没有存取流水或自动账户推断 | [FinancialPlanScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialPlanScreen.kt)、[financial-plan-service.ts](../../packages/server/src/services/financial-plan-service.ts) |
| B03.05 | 相对第1–12月预测：假定收入/投入不变、不计利息收益，显示预计备用金及累计成长计划投入（不是资产余额）；目标后固定15%仍仅作假设测算并标出超额，不自动再分配；预计金额不会随时间写成实际储备 | [FinancialPlanScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialPlanScreen.kt)、[financial-plan.ts](../../packages/shared/src/financial-plan.ts) |
| B03.06 | 场景提示：必要开支超过收入50%/超过总收入、安全垫不足1月、备用金回补、目标达成/未来15%选择；教育说明包含高息负债、收入波动、24h可取/本金风险、7天冷静期；仅页面提示，不系统推送/拦截记账，不调用付费AI，不保证收益 | [FinancialPlanScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialPlanScreen.kt)、[FinancialPlanState.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialPlanState.kt) |
| B03.07 | 首页预算卡片支持一键平滑切换“分类信封”与“四用途执行”，持久化至 `FinancialPrefs` (按 serverBaseUrl + immutable user ID (legacy server: username) 维度隔离存储，默认分类信封)；[DashboardTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DashboardTab.kt)、[FinancialPrefs.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialPrefs.kt) |
| B03.08 | “计划”底部一级页默认展示 C2 本月计划摘要；旧四用途执行、分类信封预算/结余池、测算为“明细工具”。FinancialHostScreen 保留四份固定 composition（计划/执行/信封/测算），仅 place 当前页，隐藏页不绘制/不参与触摸或无障碍树；执行/测算脏草稿守卫保留，工具返回摘要、摘要返回来源页；MainShell 统一将 `ledgerRefreshToken: Long` 失效代次与递增回调传给 FinancialHostScreen、MonthlyPlanWorkspace、MyTab 与 StatsTab，所有已确认财务写入与恢复成功后统一触发重读，跳过/取消/失败/未知不伪造成功信号；[FinancialHostScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialHostScreen.kt)、[MonthlyPlanWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/MonthlyPlanWorkspace.kt)、[MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt) |
| B03.09 | 四用途执行工作区接入服务端 `/api/v1/financial-planning`；空态“从已有工资开启”，已有周期操作栏“已有工资”进入分页选择工资（单一归属月，已纳入周期不可选），配置未启用可进入规划设置；先由服务器试算展示四项，再由用户明确确认，提交前保存操作及请求以便结果未知时同请求重放。无需再次新建工资、不自动转账；既有周期以显式 ID 追加并保留冻结规则，来源异常或周期匹配歧义时阻断。执行与退款读取使用独立 WorkOwner 代次票据；刷新有进度/禁重复/保留旧数据的错误提示。展示必要/随心实际执行与剩余，成长/应急诚实呈现“未接入实际划拨”，提供分类信封对照。空/有当前周期均有“历史方案”：每页10条读取确认周期及修订，只读查看冻结收入、比例、目标、规则与来源快照；窗口按自身时区且含起不含止，当前来源核对金额/状态明确非历史冻结值。失败可重试原请求页并保留旧行；旧手动测算最新方案仍在“测算预估”，不自动转成执行周期；[FinancialExecutionWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialExecutionWorkspace.kt)、[FinancialExecutionModels.kt](app/src/main/java/com/yansuu1/jizhang/repo/FinancialExecutionModels.kt) |
| B03.10 | 明细工具中的规划设置弹窗支持基点比例、必要开支基准、目标月数、周期时区与CAS/重放；分类映射以“跟随分类/必要/随心/待归类”表达，expectedTopologyToken CAS不变，修订/token/bps收进折叠诊断详情；[FinancialConfigSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialConfigSheet.kt)、[FinancialCategoryMappingSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialCategoryMappingSheet.kt) |
| B03.11 | 退款多原单精确分摊与审查弹窗：待审核横幅用独立“查看”按钮（≥48dp），读取失败显示错误与重试而非误报无退款；列表仅首10条（总数单独展示，更多退款分页仍未接入），支持打开既有多原单拆分弹窗查看候选原单与残余可退额度、精确分摊提交及重放；[FinancialRefundSplitDialog.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialRefundSplitDialog.kt)、[FinancialExecutionRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/FinancialExecutionRepository.kt) |
| B03.12 | 默认本月计划只读视图读取 `GET /api/v1/monthly-plan` 服务端结果：消费预算=必要+随心目标，工资10000分时显示6000分；必要/随心用途行、完整分类毛额/归属退款/净额、待核对原因及冻结区间均不由Android重算；冻结区间采用自身 IANA 时区格式化，明确含起不含止（不含终点）。周期 ready 时以该冻结窗口读取手动目标并在“本月分配参考”中并列展示“本期手动净存入”与“本期本金净投入”（无周期不伪造范围，未设置/不支持/读取失败诚实展示真实状态）；点击实际进度带入同周期 ManualGoalWindowContext 窗口上下文。应急/成长仅显示预留参考；`legacyEnvelopeReference`单独标“旧信封参考”且不叠加。`no-period`/`disabled`/旧服务404/加载失败均不伪装零计划；本地验证通过，设备未验。 |[MonthlyPlanModels.kt](app/src/main/java/com/yansuu1/jizhang/repo/MonthlyPlanModels.kt)、[MonthlyPlanRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/MonthlyPlanRepository.kt)、[MonthlyPlanWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/MonthlyPlanWorkspace.kt)、[ManualGoalProgressReadState.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManualGoalProgressReadState.kt)、[format.kt](app/src/main/java/com/yansuu1/jizhang/ui/format.kt)、[monthly-plan-service.ts](../../packages/server/src/services/monthly-plan-service.ts)|
| B03.13 | 手动存钱与投资实际进度：从月计划明细工具或本月分配参考进入，接入 `/api/v1/financial-goals`；区分应急金与投资本金，显示手动确认起始基准、累计存取、当前记录余额、应急储备缺口及月度参考假设下的投入次数（无参考不猜），投资仅跟踪实际投入与取回本金（不含收益/市值，不冒充银行证券核验资产）；服务端预测参考仅取当前包含 calculatedAt 的已冻结周期的 targetsCents.reserve，旧周期不作参考，salary-source-changed 冲突时置 null；选定历史/期间窗口不展示当前预测；支持传入 ManualGoalWindowContext，通过 requireManualGoalWindow 严格校验服务端回显范围与来源契约；期间视图展示精确窗口内的实际净存入与净投入本金；起始值与存取变动金额统一通过 `parseManualGoalYuanCents` 精确解析（BigDecimal 乘 100 与 JS 安全整数范围校验 <= 9007199254740991L，拒绝第三位小数含 1.230、负数、指数、NaN/Infinity，起始值允许 0，存取必须大于 0）；四种写入（PUT opening / POST entry / PATCH entry / DELETE entry）经由 `ManualGoalReplayCoordinator` 协调管理：先持久化后发送、成功清理 pending、响应丢失保留未决、查到已入账结果零重发、404 时确认合同支持后同键原载荷重发、400/409 确定性失败清理本地并报告；重启恢复支持含引号/换行特殊 note 精确恢复且不重新生成 UUID；历史记录支持新增/更正/软删除及整段非负校验，带 CAS 修订号与 operationId 重放保护。404 时显示明确不支持状态；明细记录采用 `ManualGoalEntryListState` 管理 `ManualGoalEntryQuery`，继续通过 `FinancialGoalRepository.listEntries` 以单页 limit=100 进行游标分页，`appendManualGoalEntryPage` 严格保证同一 revision 才能拼接下一页，杜绝混合快照，revision 变化标记 restartRequired 要求重读首屏而不丢弃编辑草稿；分页错误保留已加载项并允许原地重试；在存在窗口上下文时提供“本期明细 / 全部历史”切换，无窗口默认全部历史；已软删除记录（deletedAt != null）保留在 includeDeleted 历史中展示并禁用再次编辑/删除，不计入当前余额；更正/删除使用真实条目 ID 及全局 revision，非法删除造成后来透支整笔拒绝；设备端分页交互待验。 |[FinancialGoalModels.kt](app/src/main/java/com/yansuu1/jizhang/repo/FinancialGoalModels.kt)、[FinancialGoalRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/FinancialGoalRepository.kt)、[ManualGoalProgressWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManualGoalProgressWorkspace.kt)、[ManualGoalInput.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManualGoalInput.kt)、[ManualGoalOperationReplay.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManualGoalOperationReplay.kt)、[ManualGoalProgressReadState.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManualGoalProgressReadState.kt)、[ManualGoalEntryListState.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManualGoalEntryListState.kt)、[financial-goals.ts](../../packages/server/src/routes/financial-goals.ts)|

### 4.8 S01 工资与分配

**2026-11-04 局部协议复核：** 下表描述当前 Android 旧工资界面和请求，不代表已适配四用途基金工资。当前工作区服务端拒绝新的旧版工资创建请求（410）；同一用户、操作键及原载荷的已提交旧请求仍可重放原结果。新的基金工资创建需要 `contractVersion: 1`、`expectedFundConfigRevision` 和 `operationId`，而此 Android 表单没有发送前两者。基金工资的实际编辑/删除还需版本 1、`expectedGrantRevision` 和 `operationId`，当前客户端亦未接入；历史旧工资路径与基金工资路径不可混为一谈。仅本节、L04.11 及其相关 API/缺口/日志局部重核，未推进全库审计日；最终整合和设备验证待完成。

| ID | 当前能力与行为 | 证据 |
|---|---|---|
| S01.01 | 工资历史/表单/分配三个阶段；入口来自“计划→记工资”、“我的→工资记录”或“＋→收入→记工资”，均复用工资域而非普通交易POST。打开读取账户/工资/模板/分类；列表含金额、到账日期、账户、备注和编辑/分配/删除；GET最多最近200条、无分页搜索月份筛选。 |[SalarySheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalarySheet.kt)、[TransactionEditSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt)、[salary-service.ts](../../packages/server/src/services/salary-service.ts)|
| S01.02 | 新增工资：金额、到账日期（文本）、到账账户（必选）、分配模板、备注；默认当日且预选可用默认模板，模板选择默认折叠在“更换模板”。模板可用性通过 `isUsableSalaryTemplate(activeCategoryIds)` 校验，每个模块引用的分类必须在当前活跃分类集合中；没有可用默认模板时显示“修复分配模板”入口并阻止所有工资/计划写入；保存时遇模板/分类确定性拒绝先重新读取分类与模板再转入修复；可用模板修复后保留在表单草稿中；这只描述旧 UI，不能消除当前服务端新建请求的 410 协议不兼容。 |[SalarySheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalarySheet.kt)、[SalaryTemplateState.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalaryTemplateState.kt)|
| S01.03 | 工资金额正数最多两位小数，BigDecimal精确转分，范围≤9,007,199,254,740,991分；不接受负号/指数/空值。日期严格解析，服务端≥2000且不超过now+1天。 |[SalarySheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalarySheet.kt)、[salary-service.ts](../../packages/server/src/services/salary-service.ts)|
| S01.04 | Android 新增表单仍发送模板 ID，不能在当前服务端创建新工资（见本节协议复核）。服务端新的版本 1 工资按基金配置比例生成四用途 grant 快照，不生成旧模板分配；工资存 salary_records 而非 transactions，账单列表不显示工资，计入账户余额及本月收入。 |[SalarySheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalarySheet.kt)、[salary-service.ts](../../packages/server/src/services/salary-service.ts)、[stats-service.ts](../../packages/server/src/services/stats-service.ts)|
| S01.05 | Android 按工资 ID 先读详情，再用旧 PATCH 提交金额、日期、账户和备注；未改金额/分配时不发送 allocations，编辑不允许选择另一模板。对新建基金工资，实际更改需要版本 1、grant revision 和操作键，当前 Android 不兼容；历史工资行为以服务端当前校验为准。 |[SalarySheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalarySheet.kt)|
| S01.06 | 修改工资金额时显示同步分配编辑，所有模块非负且最多两位小数，总和必须等于新工资金额，显示差额/超额；零分配项不提交、不能全零；确认“同时替换工资分配”后一次 PATCH 包含新金额及 allocations；这是旧模块分配请求，不适用于新基金工资。 |[SalarySheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalarySheet.kt)|
| S01.07 | 独立“分配”流程读取该工资ID详情，可对支出分类填写金额，保留当前资料之外历史分类项并注明；总和=服务器工资金额才能保存；二次确认后发送旧 PUT 请求替换模块分配，非追加；这不是四用途 grant 的编辑协议，也不证明新基金工资已适配。 |[SalarySheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalarySheet.kt)|
| S01.08 | 旧分配表单合计仅用于验证，不代替预算/池计算；旧操作成功时返回历史并服务器重读，刷新失败明确“操作已确认但列表未刷新”。这不代表基金工资分配已由 Android 接入。 |[SalarySheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalarySheet.kt)|
| S01.09 | Android 删除二次确认标明工资金额、日期及同时移除分配，再发送无请求体的旧 DELETE；旧工资可按服务端规则软删除工资及分配，不进入 Android 交易回收站。新基金工资要求版本 1、grant revision 和操作键；当前无请求体删除不兼容，不能宣称删除成功。 |[SalarySheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalarySheet.kt)、[salary-service.ts](../../packages/server/src/services/salary-service.ts)|
| S01.10 | 表单/分配有未保存修改，顶部返回和系统返回提示放弃/继续编辑；历史返回退出流程。加载失败可重试，提交状态/字段错误/总错误分开，分配失败保留输入，401统一退出。存在旧无键待核对记录时提供查看历史与显式结束本机未决记录确认（不变更服务端工资）。 |[SalarySheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalarySheet.kt)|
| S01.11 | 三阶段切换有短距离水平移动+淡入淡出，时长baseMillis；列表项位移动画；减少动态直接终态。不能据此宣称十二原则每项实机验收通过。 |[SalarySheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalarySheet.kt)|
| S01.12 | Android 旧流程将工资保存与纳入旧执行计划视为两笔独立操作：工资载荷带 `operationId` 并先持久化待重放，但新旧协议不兼容（见本节协议复核），不能据此认定新工资或新计划可成功；成功后最多一次紧凑预览/明确“纳入本月计划”确认，展示冻结日期使用 `formatFrozenFinancialWindow`（显式 IANA 时区格式化 `YYYY-MM-DD — YYYY-MM-DD (timeZone，不含终点)`，明确 end 排他，不随设备本地时区漂移）；SalaryFinancialPrompt 将 `onPlanConfirmed` 与 `onFinished` 显式解耦，跳过保持待确认且不通知计划变更，确认成功才触发计划刷新；确认失败不重建工资；各操作未知结果按原键核对/重放。历史无键/键不一致未决记录零自动重发，保留待核对状态供人工核对并显式结束。 |[SalarySheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalarySheet.kt)、[SalaryOperationReplay.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalaryOperationReplay.kt)、[SalaryFinancialPrompt.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalaryFinancialPrompt.kt)、[format.kt](app/src/main/java/com/yansuu1/jizhang/ui/format.kt)|

### 4.9 M01 分类、账户、标签管理

| ID | 当前能力与行为 | 证据 |
|---|---|---|
| M01.01 | 我的→分类与账户进入一个页面，内部分类/账户/标签tab；显式刷新；全量列表无分页搜索。首次同时读分类、账户、标签、账户余额，任一失败会影响初次加载。 |[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)|
| M01.02 | 分类列表展示支出/收入、内建标记、图标名称、色块、父模块/独立收入/子分类关系；子分类缩进；支持新建、编辑、上移/下移和非内建删除。 |[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)|
| M01.03 | 分类表单：名称必填（后端max40）；类型只在新建可选（0支出/1收入）；支出可选独立/顶级支出父模块；收入无父级；图标10种（餐饮/交通/住房/购物/娱乐/工资/医疗/教育/宠物/其他）；颜色12个预设，未命中预设保留原色。 |[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)、[master-data-service.ts](../../packages/server/src/services/master-data-service.ts)|
| M01.04 | 后端只支持两层，不能自己作为父级，父级必须活跃支出顶级分类；已有子级的分类不能改成子级；修改分类类型不提供。 |[master-data-service.ts](../../packages/server/src/services/master-data-service.ts)|
| M01.05 | 删除前GET usage展示活跃交易引用数及子类数；软删除保留历史账单名称，子类脱离成为独立分类，同时退役引用该分类的周期规则和pending occurrence。内建分类可编辑但不可删。 |[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)、[master-data-service.ts](../../packages/server/src/services/master-data-service.ts)|
| M01.06 | 账户列表显示类型、内建、服务器当前余额、初始余额、负余额提醒；新建/编辑/上移/下移、非内建可删。 |[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)|
| M01.07 | 账户输入名称、6类型（现金/储蓄卡/信用卡/支付宝/微信/其他）、初始余额；负数允许，BigDecimal 必须能精确转成整数分且在 JS 安全范围内。UI 提示最多两位小数，但没有小数位正则，带多余末尾零或指数的数值只要精确到分仍可接受；空余额按0处理，名称后端max40。 |[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)|
| M01.08 | 删除账户GET usage显示引用交易数和将离开总余额的当前余额，历史账单保留；后端软删除账户并清引用周期规则/pending。账户内建可编辑不可删。 |[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)、[master-data-service.ts](../../packages/server/src/services/master-data-service.ts)|
| M01.09 | 标签不支持独立新增；使用账单标签后派生名称/count，按使用次数降序；可改名（必填）与删除。改名为已存在名会合并去重；删除仅从交易移除该标签，不删交易；确认后统一改写。 |[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)、[master-data-service.ts](../../packages/server/src/services/master-data-service.ts)|
| M01.10 | 分类/账户上移下移是调用move(dir=-1/+1)与相邻sort_order交换，再刷新；不是拖动排序；边界无相邻项时后端无动作。 |[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)、[master-data-service.ts](../../packages/server/src/services/master-data-service.ts)|
| M01.11 | 加载占位、初次错误/重试、空态与新建按钮；刷新/保存/删除时busy禁用控件；对话框错误保留草稿；没有未保存编辑放弃确认（可直接取消/关闭）。 |[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)|

### 4.10 M02 工资分配模板（已退役，源码保留）

> **2026-11-05 状态：分配模板已退役。** Android 源码仍显示以下 M02 入口和按钮，但服务端只允许读取旧模板；写入和应用返回 410。以下 M02.02–M02.06 不再端到端可用；稳定 ID 全部保留，不回收、不复用。

| ID | 当前能力与行为 | 证据 |
|---|---|---|
| M02.01 | 模板编辑器收进“我的→更多工具→分配模板”（低频配置）；计划明细也可从工资/预算工具跳转；列表显示名字、默认标记、比例合计和每分类比例，显式刷新，无分页。 |[MyTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/MyTab.kt)、[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)|
| M02.02 | 新建/编辑模板名称和若干支出分类模块，每项比例以百分数输入；可逐项添加/移除，不默认全量分类；保留缺失分类并明确要求移除后保存。 |[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)|
| M02.03 | 模板名必填，至少一个模块；比例每项>0≤100，不能空/非法；总和距离100%必须小于0.01个百分点（后端fraction容差1e-4）；父类与子类不能同时选择。显示实时合计/剩余/格式问题。 |[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)、[template-service.ts](../../packages/server/src/services/template-service.ts)|
| M02.04 | 可将非默认模板设为默认；成功刷新并反馈。新增工资自动预选默认模板，但历史工资分配快照不会随模板编辑改动。 |[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)、[SalarySheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalarySheet.kt)|
| M02.05 | 删除须确认“历史工资分配保留”；当前UI对默认模板也显示删除按钮，但服务端拒绝删除默认模板，需先设另一模板为默认。 |[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)、[template-service.ts](../../packages/server/src/services/template-service.ts)|
| M02.06 | 应用当前周期须二次确认，覆盖该周期所有现役工资的分配快照（不是仅最近一笔，也不改工资金额）；成功反馈；无工资/周期服务端拒绝。 |[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)、[salary-service.ts](../../packages/server/src/services/salary-service.ts)|
| M02.07 | 默认模板/模板列表读取来自服务器；表单保存失败保留输入；初次加载/错误/空态、新建入口、busy防连续操作；直接取消表单无放弃草稿确认。 |[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)|

### 4.11 B02/S02 统计与图表

本节 C3 于 **2026-10-30** 局部源码复核；自动化门禁记录见任务状态，设备触摸、快速切换、返回、TalkBack仍待验，不用构建成功代替设备证据。

| ID | 当前能力与行为 | 证据 |
|---|---|---|
| B02.01 | 分类排行、全部账户收支月趋势、无需AI的消费复盘；分类/趋势独立加载、失败与重试。同条件刷新可保留明确标注的旧数据；切范围/账户立即隔离旧结果，代次与销毁守卫阻止旧响应发布。结余池移出本页。 |[StatsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/StatsTab.kt)、[StatsWindow.kt](app/src/main/java/com/yansuu1/jizhang/ui/StatsWindow.kt)|
| B02.02 | 图表/明细开关收进“更多范围与显示”；完整金额文字明细不依赖Canvas触摸，开关不新增API。 |[StatsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/StatsTab.kt)|
| B02.03 | 默认本月分类排行；更多中有近30天、指定月及单账户精确筛选；旧“近3个月”分类选项移除（保留ID，不再给与趋势重复范围），不提供自由起止。账户元数据 includeDeleted=true，失败可重试，不静默切账户。 |[StatsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/StatsTab.kt)|
| B02.04 | 指定月弹窗年+/−（2000..9998）和12个月，应用/取消；从GET stats/window读取服务端半开区间、IANA时区、真实起止和标签，不用设备日历推算请求范围。 |[StatsWindow.kt](app/src/main/java/com/yansuu1/jizhang/ui/StatsWindow.kt)|
| B02.05 | 近30天为服务端同次now−720小时到now，不到下月初；当前服务不支持window时显示升级/不可用，不退回设备估算或假零。 |[stats-window.ts](../../packages/shared/src/stats-window.ts)、[StatsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/StatsTab.kt)|
| B02.06 | 环图仅绘正金额，空/零总额明确空态；点扇区看值，点击至少48dp的分类文字行打开同范围全部支出账单，来源统计仍挂载，关闭后保留范围/滚动。 |[Charts.kt](app/src/main/java/com/yansuu1/jizhang/ui/Charts.kt)、[TransactionDrilldownScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionDrilldownScreen.kt)|
| B02.07 | 分类只统计毛支出、精确categoryId（不含子类），按金额降序/名称；退款收入另列服务端refundIncomeCents，不冲减支出、不加进消费总额。 |[stats-service.ts](../../packages/server/src/services/stats-service.ts)、[types.ts](../../packages/shared/src/types.ts)|
| B02.08 | 默认6月趋势；更多可选3/6/12月，指定月份时用endMonth为末月；字幕来自服务端完整月份序列，全部账户趋势与上方分类账户筛选明确区分。收入含普通收入/工资/退款，补空月为0；历史netExpenseCents字段保持毛支出含义。 |[StatsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/StatsTab.kt)、[stats-service.ts](../../packages/server/src/services/stats-service.ts)|
| B02.09 | 双柱图例、点击值、无障碍描述和文字明细统一称“收入/支出”，不再称净支出；明细列服务端退款收入子项（已包含于收入）。账面结余不称实际存款。 |[Charts.kt](app/src/main/java/com/yansuu1/jizhang/ui/Charts.kt)|
| B02.10 | 结余池趋势移至“计划→明细工具→分类信封预算→高级预算”，展开才GET pool-trend；保留线图/逐期明细及负池/零轴/单点/空态；旧结转不是当前消费额度或实际存款。 |[BudgetTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/BudgetTab.kt)、[Charts.kt](app/src/main/java/com/yansuu1/jizhang/ui/Charts.kt)|
| B02.11 | 图形入场/切换/渐显沿用tokens，不做金额动画；有文字明细/语义描述，但TalkBack、色盲、小屏真实交互仍待验。 |[Charts.kt](app/src/main/java/com/yansuu1/jizhang/ui/Charts.kt)|
| B02.12 | 无AI消费复盘使用同范围分类排行，显示消费最多分类及来源；另读已确认计划，独立标注冻结范围/净消费口径，待核对或无计划时不猜精确超支。统计窗口确定后独立读取同周期目标 window 值，展示本期手动净存入与本金净投入；账户筛选下明确注明“手动存投（全部目标，未按账户筛选）”，不混入账户总额或推导净储蓄率；异步代次守卫丢弃过期 query。实际存钱/投入不由收支差额推算；C4实际记录另行接入。 |[StatsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/StatsTab.kt)、[FinancialGoalRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/FinancialGoalRepository.kt)|
| B02.13 | 分类下钻复用完整加载器（500笔/批、100000安全上限），服务端精确from/to/category/account/type=expense条件一致，合计由服务端返回而非Android求和；完整性失败拒绝部分成功。仅查看详情，不新增编辑路径。 |[TransactionDrilldownScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionDrilldownScreen.kt)、[TransactionMonthLoader.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionMonthLoader.kt)|

### 4.12 当前账务规则（以实际函数为准）

1. **毛支出/退款收入**：[types.ts](../../packages/shared/src/types.ts) expenseContribution只给type=0正金额，所有收入贡献0；`:195` incomeContribution给type=1全额，含退款。旧frontend规范与少量源码注释“退款负支出”“净支出”已过时，不能写成现行规则。
2. **工资独立且无自动去重**：salary_records增加收入和到账账户余额，不写transactions。若同一笔工资又手动创建收入账单，两条均计入收入，App没有重复检测。[stats-service.ts](../../packages/server/src/services/stats-service.ts)、`.trellis/spec/backend/index.md`。
3. **账户余额**：初始余额+全部活跃收入+工资+转入−全部活跃支出−转出；没有月份过滤，软删除交易/工资/转账不贡献；已删账户不在余额汇总里，历史账单仍存在。[account-balance.ts](../../packages/shared/src/account-balance.ts)、`:217`。
4. **退款关联只溯源**：对账链接不改写原支出，不冲减支出、不恢复预算，退款增收入/余额。服务端校验关联ID存在、活跃、为非退款支出、去重且不自关联。[transaction-service.ts](../../packages/server/src/services/transaction-service.ts)、[types.ts](../../packages/shared/src/types.ts)。
5. **预算实时由shared引擎计算**：同周期多次工资的模块分配相加；自然月模式按发薪所在月合组；配置1..28起始日时按发薪所在月起始日归属（发薪日早于起始日也分到当月该起始日）。模块消费使用区间内活跃支出，未在模板中的消费仍成为零预算模块。父子支出按顶级父类归集；期末剩余进入累计结余池，超支借用池，池可负；不物化余额。[budget-engine.ts](../../packages/shared/src/budget-engine.ts)、`:150`。
6. **周期起点语义**：自然月group的start是组内最早发薪日（`earliestDate`），不是UI自行假定月1号；账务引擎另按自然月边界计算。在文档中应保留“服务端返回的周期起点”，不要把UI日期擅改成月首。[budget-engine.ts](../../packages/shared/src/budget-engine.ts)、[budget-overview-service.ts](../../packages/server/src/services/budget-overview-service.ts)。
7. **日期/精度**：请求金额整数分、时间epoch毫秒；日期输入和部分统计范围来自设备本地时区，服务器月窗口/周期计算来自服务器时区。文档须区分，不宣称跨时区一致已验收。
8. **删除范围**：账单可进交易回收站；工资/模板/基础资料软删除没有Android恢复入口。删除前确认不等于存在撤销能力。

### 4.13 API 对照与仅服务端/尚未暴露能力

| Android 功能 | 接口 | 与后端的差异 |
|---|---|---|
| 月账单/搜索/关联picker/最近列表 | GET `/api/v1/transactions`（`accountId` 为单个资金账户 ID，全部账户时省略）；GET `/:id`；POST；PATCH `/:id`；DELETE `/:id` | 新 `search` 与账户/类型等条件组合，全部历史省略 from/to；搜索逐页要求顶层 `searchVersion=1` 及一致的64位十六进制 `searchRevision`。旧 `q` 协议不变且账单搜索不使用它。自动500/批完整读取（100000笔上限）；picker仍50/页，首页5笔。历史元数据 includeDeleted 不等于包含已删除账单 |
| 四用途交易 | POST `/api/v1/transactions`；PATCH `/api/v1/transactions/:id` | 服务端 `fundPurpose` 支持 `growth`、`reserve`、`essentials`、`joy` 及显式清除；用途 PATCH 要求操作键、`expectedFundPurposeRevision` 与交易 token。Android 仅使用旧的两值支出 `financialPurpose`；canonical 显式用途存在后，旧用途修改缺少基金 revision 会返回 409，尚未接入新合同（L04.11）。 |
| 原支出退款反查 | GET `/api/v1/transactions/:id` 返回refundSummary/refundDetails | 当前Android详情未展示这些字段 |
| 分类/账户 | GET、POST `/categories` `/accounts`；PATCH/DELETE `/:id`；POST `/:id/move`；GET `/:id/usage` | 后端可传sortOrder，Android仅上下移动；分类类型编辑未开放；includeDeleted用于历史显示但管理列表不显示已删除项 |
| 余额 | GET `/api/v1/accounts/balances` | 服务端还提供每账户flow、正资产/负债等，首页只展示净总余额，管理只展示每账户balance |
| 标签 | GET `/tags`；PATCH `/tags` {from,to}；DELETE `/tags/:name` | 无独立新建接口/标签表，App从交易创建标签 |
| 预算 | GET `/budget/periods`、`/budget/overview?periodStart` | Android仅切已有周期；无预算直接编辑接口 |
| 每日账单收支 | GET `/api/v1/transactions/daily-summary`；与账单相同筛选、`from/to` 必填且范围≤32天，`timeZone` 为合法 IANA 时区；忽略limit/offset | 月搜索须返回顶层 `searchVersion=1` 与列表一致的 `searchRevision`（空结果也验证）；全部历史不调用。`items[{day,expenseCents,incomeCents,count}]` 金额整数分；不可用时不本地估算 |
| 四账户理财计划 | GET/PUT `/financial-plan`、POST `/financial-plan/preview` | 三项严格整数分输入；独立settings保存一份当前方案，revision CAS/精确重试；目标与预测由shared计算；不写账本、不调用AI |
| 基金配置 | GET/PUT `/api/v1/financial-funds/config` | 服务端配置带 revision；当前 Android 工资表单未接入此配置或新基金工资合同，不表示四用途 UI 已实现 |
| 工资 | GET `/salaries`、`/:id`；POST；PATCH `/:id`；PUT `/:id/allocations`；DELETE `/:id` | Android 发旧模板 POST，当前服务端对尚未提交的旧请求返回 410；已提交的相同用户/键/原载荷仍可重放。新建基金工资须 `contractVersion: 1`、`expectedFundConfigRevision`、`operationId`，不接受模板/allocations；新基金工资编辑/删除须版本 1、`expectedGrantRevision` 和 `operationId`，旧 Android 未实现。旧 PUT 是模块分配而非基金 grant 写入。列表最多200，App无分页 |
| 模板（已退役，只读兼容） | GET `/templates`；原 POST/PATCH/DELETE 模板路由 | GET 可读取旧数据并包含弃用标记；所有模板写入及应用当前周期返回 410 `TEMPLATE_RETIRED`。Android 仍展示对应按钮，但写入不再可用；迁移 022 保留旧数据并将模板名加入标签目录。 |
| 周期设置 | GET/PUT `/settings`，cycleStartDay=null或1..28 | Android暴露在SettingsTab，由其他研究覆盖 |
| 统计与分类下钻 | GET `/stats/window?kind=month\|last30&month?`、`/category-share?from&to&accountId?&categoryId?`、`/monthly-trend?months&endMonth?`、`/pool-trend` | window不传month默认服务端当前月；分类/明细使用同一个from/to及精确ID；响应expenseCount/totalCents与nullable账户/分类条件回显；趋势保留1..36服务端/3、6、12 Android；旧range/month-window仍兼容但统计页不再调用 |

<a id="operations"></a>
## 5. 数据文件、物品、转账、回收站和周期

### 5.1 D：数据导入、导出与备份

入口：我的 → 数据管理。该页面为四组功能；平台导入替换本页显示，通过“关闭”返回；所有文件操作使用 Android 系统文件选择/保存组件。本轮 T09 对 D006/D009/D014/D015 的源码核对日期：2026-10-31（源代码与回归用例；SAF/设备路径仍待验）。

| ID | 当前实际功能、字段或约束 | 证据 |
|---|---|---|
| D001 | 导出账单 CSV；系统“另存”初始文件名 transactions.csv，可自行选保存位置 |[DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt)；[PortabilityRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/PortabilityRepository.kt)|
| D002 | 导出工资 CSV，初始 salaries.csv |[DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt)；[portability-service.ts](../../packages/server/src/services/portability-service.ts)|
| D003 | 导出周期规则 CSV，初始 recurring.csv |[DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt)；[portability-service.ts](../../packages/server/src/services/portability-service.ts)|
| D004 | 导出转账 CSV，初始 transfers.csv |[DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt)；[portability-service.ts](../../packages/server/src/services/portability-service.ts)|
| D005 | 下载走认证 API；CSV 为 UTF-8，服务端含 BOM；保存成功显示“CSV 已保存到所选位置”，取消保存不执行下载 |[DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt)；[portability.ts](../../packages/server/src/routes/portability.ts)|
| D006 | 本应用账单 CSV 导入：账单/转账二选一，切换清空所选文件和上次结果；未选文件不展示确认导入按钮 |[DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt)|
| D007 | 选 CSV：文件 MIME 允许任意类型以兼容 provider，但真实名称必须 .csv（忽略大小写）、内容非空、≤10 MiB；本应用 CSV 按 UTF-8 读取，不执行平台 GBK 解码 |[DocumentFiles.kt](app/src/main/java/com/yansuu1/jizhang/ui/DocumentFiles.kt)；[DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt)|
| D008 | 取消文件选择保留此前文件；真正另选文件先清空旧文件/结果，读取失败显示错误 |[DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt)|
| D009 | 点击确认即以 text/csv 内容上传，无本应用 CSV 预览；处理中阻止重复导入，只有响应含完整非负整数 inserted/skipped/total 时才显示成功并调用 onDataChanged 使现有账簿摘要失效；缺字段/未知结果只提示核对，不递增刷新代次 |[DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt)；[PortabilityRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/PortabilityRepository.kt)|
| D010 | 账单 CSV 必需栏位：id/date/type/amount/category/account/note/tags/isRefund；type=expense/income，amount>0 且≤2 位小数，date=YYYY-MM-DD，tags 用竖线分割 |[portability-service.ts](../../packages/server/src/services/portability-service.ts)|
| D011 | 本应用 CSV 同 ID（包括已经软删除的数据）跳过；未知分类/账户、空 ID、金额/日期/类型/退款标志错误报错；先校验再事务写入，不能静默创建未知主数据 |[portability-service.ts](../../packages/server/src/services/portability-service.ts)|
| D012 | 转账 CSV 必需 id/date/amount/from/to/note；账户按名称匹配且必须是两个不同账户；同 ID 跳过；成功/错误交互同账单导入 |[portability-service.ts](../../packages/server/src/services/portability-service.ts)|
| D013 | 服务端兼容旧“支出类型的退款”CSV，归一化为收入退款；没有合法退款分类时明确拒绝 |[portability-service.ts](../../packages/server/src/services/portability-service.ts)|
| D014 | 平台账单文件导入统一入口：从数据管理或AI助手均进入统一新平台导入宿主（PlatformImportHost），复用多文件批次工作区；默认无AI调用纯人工核对，创建批次显式 `analyse = false`；支持微信/支付宝 CSV 与 XLSX；原始字节上传，Android 不本地解析金额或重算规则；Data 与 Assistant owner 包含 FinancialScope、ApiRequestIdentity、source/入口会话，workspaceRef 保留协议 conversationId；picker/start/workspace 响应以 owner+ticket 隔离；确认入账成功后仅通过唯一 ledgerRefreshToken 失效回调刷新账簿摘要 |[PlatformImportHost.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/imports/PlatformImportHost.kt)；[PlatformImportState.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/imports/PlatformImportState.kt)；[AssistantBatchImportWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchImportWorkspace.kt)；[MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt)；[MyTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/MyTab.kt)|
| D015 | 平台文件限额与空选择保护：支持 1–5 个文件，单文件 ≤ 5 MiB，合并总大小 ≤ 8 MiB，整批最多 500 行；取消选择或空选择不发起网络请求、不创建空会话与空批次；初始 Assistant 文件也经限额校验；未决批次重试只复用同一 clientRequestId、同一协议会话及同序、同文件名/bytes 的原件集，拒绝同 key 换 bytes；新 Data 会话 ID 已取得后重试不再创建会话；若新会话创建响应未知且服务端无按键查询能力，则阻断重复创建并要求先核对 |[PlatformImportHost.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/imports/PlatformImportHost.kt)；[PlatformImportState.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/imports/PlatformImportState.kt)；[DocumentFiles.kt](app/src/main/java/com/yansuu1/jizhang/ui/DocumentFiles.kt)|
| D016 | 预览行展示备注（缺则交易对方）、日期、元金额、分类，以及已入账/可能重复/忽略原因状态；实际拼接表达式应设备核对其多状态提示完整性 |[DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt)|
| D017 | 默认只勾选非已入账、非忽略、非可能重复行；已入账/忽略行不能勾选；可能重复行可以人工勾选确认 |[DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt)|
| D018 | 每行“改分类”输入自由文本分类名称，确认应用/取消保留旧值；上传 categoryOverrides；没有分类下拉、没有全选/取消全选按钮 |[DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt)|
| D019 | 确认导入所选 N 行：上传原文件/selectedIds/overrides，非 dryRun；成功关闭面板，主页面展示平台、新增数、支出与收入金额 |[DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt)|
| D020 | 平台稳定 wx-/ali- 订单 ID 去重；可能重复由服务端同平台账户的同本地日期/类型/金额推断，不自动阻止人工选择 |[portability-service.ts](../../packages/server/src/services/portability-service.ts)；[platform-bills.ts](../../packages/shared/src/platform-bills.ts)|
| D021 | 平台自动创建或恢复命名为微信/支付宝的账户及必要分类；未知分类行为与本应用 CSV 不同。退款标志来自独立实际收入流水的来源交易类型/分类证据，与所选应用分类名称无关；原退款购买保留支出，平台导入不生成退款流水或建立退款关联 |[portability-service.ts](../../packages/server/src/services/portability-service.ts)、995–1074|
| D022 | 平台忽略无效金额、中性/不计收支、失败/关闭等状态及部分充值提现还款、资金划转/理财；成功平台收入优先允许。符合其他条件的已退款/全额退款原支出仍保留毛额并附核对退款提示，不自动生成退款或关联；实际导入与设备展示仍分别核验 |[platform-bills.ts](../../packages/shared/src/platform-bills.ts)|
| D023 | 备份列表自动读取，显示文件名、体积与创建时间；“立即备份”后重读；空/加载/错误状态存在。多用户后端按会话隔离为个人备份，普通用户仍可备份自己的账本 |[DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt)；[portability-service.ts](../../packages/server/src/services/portability-service.ts)|
| D024 | 多用户服务的API备份是当前账号私有账本 .db 快照，不包含其他账号/中央身份库，也不是手机副本；全站备份/恢复属于服务器运维，客户端不可用个人快照替换身份库 |[DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt)；[portability-service.ts](../../packages/server/src/services/portability-service.ts)|
| D025 | 恢复只有说明文字：服务器停服/备份当前库/核对快照/按部署文档恢复/健康与账本检查；无 APP 内下载数据库、删除备份、恢复数据库端点 |[DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt)；[portability.ts](../../packages/server/src/routes/portability.ts)|
| D026 | 工资、周期规则只能导出，没有对应导入；CSV 不是整库备份，账单 CSV 没有 refund_links 关联字段、工资 CSV 是记录及 allocations 快照、周期规则 CSV 不含账户列/完整历史 |[portability-service.ts](../../packages/server/src/services/portability-service.ts)；[portability.ts](../../packages/server/src/routes/portability.ts)|

### 5.2 I：物品资产、照片与抠图

入口：我的 → 物品资产。物品不属于财务账单，不会改变账户余额、预算或收支统计。实现的是持有成本/日均成本，不是会计折旧模型，没有折旧率、寿命、残值、折旧方法输入。

| ID | 当前实际功能、字段或约束 | 证据 |
|---|---|---|
| I001 | 物品状态筛选：全部/使用中(active)/闲置(idle)/已售出(sold)/已退役(retired)；换状态回第 1 页 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)；[item-service.ts](../../packages/server/src/services/item-service.ts)|
| I002 | 手动搜索名称/分类/品牌/型号/备注；输入后按“搜”才查询；后端 q≤100 字；API category 精确筛选在 Android 未提供独立控件 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)；[item-service.ts](../../packages/server/src/services/item-service.ts)|
| I003 | 每页 50，上一页/下一页/当前页/总数；排序由服务端购入日期倒序、更新时间倒序、ID 决定；API 最大 200/offset≤1,000,000 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)；[item-service.ts](../../packages/server/src/services/item-service.ts)|
| I004 | 概览显示在册购入总额/currentDailyCostCents；概要独立加载失败不妨碍列表。概要为全体未删除物品，不随列表过滤变化 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)；[item-service.ts](../../packages/server/src/services/item-service.ts)|
| I005 | 列表每项名称、状态、分类、持有天数、购入价（空为未记录）、日均成本（未知有占位），点击详情；加载、空/无搜索结果、错误状态 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)|
| I006 | 添加/编辑：名称*、物品自由文本分类、品牌、型号、备注、购入日期 YYYY-MM-DD、可空购入价格（元）、可选关联已有支出、使用中/闲置 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)|
| I007 | 保存：名称非空、元金额解析有效；可空价格发送 null，类别空的新物品默认“其他”；服务端名称≤120、分类≤60、品牌/型号/备注各≤500 字，价格非负 safe integer 分；日期非负整数时间戳且不晚于今天 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)；[item-service.ts](../../packages/server/src/services/item-service.ts)、454–474|
| I008 | 保存成功返回列表并刷新；失败保留填写内容；取消直接关闭，当前物品编辑没有独立脏表单离开确认/持久化草稿 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)|
| I009 | 购入关联只能是活跃非退款支出，售出关联只能是活跃非退款收入；选择已有账单不新增/修改账单；旧关联账单后来删掉不影响物品历史 |[LedgerLinkPicker.kt](app/src/main/java/com/yansuu1/jizhang/ui/LedgerLinkPicker.kt)；[item-service.ts](../../packages/server/src/services/item-service.ts)|
| I010 | 关联选择器：按收支类型、每页 50，显示金额/日期/备注；单选选择、清除关联、取消；物品调用没传 onAuthExpired 回调，选择器局部可设置过期提示，但非登录 401 同时由 ApiClient 拦截器与 MainActivity 全局流程清会话并返回登录。选择器无点击跳到账单详情的回调 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)；[LedgerLinkPicker.kt](app/src/main/java/com/yansuu1/jizhang/ui/LedgerLinkPicker.kt)、144 起；[ApiClient.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiClient.kt)、[MainActivity.kt](app/src/main/java/com/yansuu1/jizhang/MainActivity.kt)|
| I011 | 物品详情重新 GET 数据及照片，照片框按原比例显示，区分无照片/照片已存但无法预览；可返回、重试加载、编辑 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)、582|
| I012 | 当前详情展示名称、状态、持有天数与日均成本；不完整展示 DTO 的品牌/型号/备注/购入日期/购入价/结束日期/售出价/净成本/买卖关联/创建更新时间 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)；[item-service.ts](../../packages/server/src/services/item-service.ts)|
| I013 | 上传照片：系统 image/* picker、原字节与 provider MIME（缺省 JPEG）直接 PUT 后刷新；手机默认读取≤5 MiB；服务端仅接受 JPEG/PNG/WebP，≤2 MiB、签名及尺寸匹配、≤4000 万像素 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)；[DocumentFiles.kt](app/src/main/java/com/yansuu1/jizhang/ui/DocumentFiles.kt)；[item-service.ts](../../packages/server/src/services/item-service.ts)|
| I014 | 一物品最多一张照片，上传替换当前照片；图片 BLOB 存数据库因此跟随整库备份；图片 GET 认证、no-store/nosniff |[item-service.ts](../../packages/server/src/services/item-service.ts)；[items.ts](../../packages/server/src/routes/items.ts)；[item-assets.md](../../.trellis/spec/backend/item-assets.md)|
| I015 | 删除照片确认弹窗；资料保留，图片从服务器移除；busy 时按钮阻止重复操作；失败显示错误 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)|
| I016 | 生成抠图候选需已保存照片且无现存 job；照片解码采样到至多约 1600 边，再压缩 WebP 质量 90 后 POST；生成不是识别物品名称/分类，也不会自动选择 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)|
| I017 | jobId 后每 1500ms 轮询；queued/running/ready/failed/cancelled；ready 下载每个 WebP 预览，显示候选；failed/cancelled 停止轮询 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)；[item-cutout-client.ts](../../packages/server/src/services/item-cutout-client.ts)|
| I018 | 点“使用此候选”下载透明 PNG → PUT 为照片 → 检查上传成功 → 刷新 → 清理 job；未成功上传保留原图。取消抠图 DELETE job，清空候选/预览、原图保留 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)|
| I019 | worker 服务可选；普通照片上传不依赖 worker。未配置 worker/未就绪/过载/超时/已过期任务会明确报错；候选是临时结果，离开页面不保存 jobId，未实现离开时自动取消 |[item-cutout-client.ts](../../packages/server/src/services/item-cutout-client.ts)；[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)|
| I020 | worker 默认输入≤2 MiB、源≤4000万像素、归一化边长≤1600、≤8候选、≤2活跃job、≤3保留job、超时120s、结果TTL600s；串行 SAM2 推理、取消/清理临时文件；透明候选≤16 MiB，预览≤2 MiB |cutout [settings.py](../../packages/cutout/app/settings.py)；[jobs.py](../../packages/cutout/app/jobs.py)、207–223；[engine.py](../../packages/cutout/app/engine.py)|
| I021 | “结束持有”：确认框填写结束日期，调用 retire；“售出物品”：结束日期、非负卖出价（元，UI 必填）、可选关联收入；终止前提 active/idle，结束日期不早于购入且不晚于今天 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)；[item-service.ts](../../packages/server/src/services/item-service.ts)|
| I022 | “删除物品”确认后软删除，仅物品不删除账单；物品不会出现在账单回收站，也没有客户端恢复物品功能 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)；[item-service.ts](../../packages/server/src/services/item-service.ts)；[trash.ts](../../packages/server/src/routes/trash.ts)|
| I023 | 服务端持有天数为本地日期差≥0；日均成本=四舍五入(净成本/天数)，同日或未知净成本为 null；active/idle/retired 净成本=购入价；sold 净成本=购入价−售出价，可负 |[item-service.ts](../../packages/server/src/services/item-service.ts)|
| I024 | 服务端 currentDailyCost 只加 active/idle 的有效日均成本；累计购入总额加所有未删除且已知购入价。概要还返回总数及4状态数量，Android 未展示这些数量 |[item-service.ts](../../packages/server/src/services/item-service.ts)；[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)|
| I025 | 编辑 sold/retired 并选 active/idle 可重新打开，服务端清空结束日期、售出价、售出关联；直接 PATCH 到新的 sold/retired 状态禁止，必须生命周期端点 |[ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt)；[item-service.ts](../../packages/server/src/services/item-service.ts)|

### 5.3 T：账户间转账与账单回收站

入口：我的 → 转账、我的 → 回收站。转账是独立表，只改变两个账户之间的资金位置，不计入收入、支出或预算。

| ID | 当前实际功能、字段或约束 | 证据 |
|---|---|---|
| T001 | 转账列表每页 50、总数/页码/上一页下一页/刷新/重试/空状态 |[TransfersTrashTabs.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransfersTrashTabs.kt)|
| T002 | 行展示备注（空有占位）、账户名称方向、日期与元金额；账户名读取失败显示信息不可用，已删除账户显示已删除；不会把 ID 直接当名称 |[TransfersTrashTabs.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransfersTrashTabs.kt)|
| T003 | 新建/编辑：转出账户、转入账户、金额（元）、日期 YYYY-MM-DD、备注；账户菜单来自账户 API；交换方向按钮；保存/取消 |[TransfersTrashTabs.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransfersTrashTabs.kt)|
| T004 | 客户端金额>0、账户非空且不同、日期可解析；服务端金额为正 safe integer 分，账户存在未删除，日期≥2000-01-01 且≤now+1日缓冲；备注必须文本 |[TransfersTrashTabs.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransfersTrashTabs.kt)；[transfer-service.ts](../../packages/server/src/services/transfer-service.ts)|
| T005 | 编辑更改金额/日期/备注或账户，POST/PATCH 成功返回列表刷新；失败保留编辑。转账编辑未实现脏表单离开确认 |[TransfersTrashTabs.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransfersTrashTabs.kt)|
| T006 | 转账删除需确认“转账没有回收站”，API 实为软删除；两边余额依据 live transfers 重算，因此撤销转账对余额的影响；无恢复转账端点 |[TransfersTrashTabs.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransfersTrashTabs.kt)；[transfer-service.ts](../../packages/server/src/services/transfer-service.ts)|
| T007 | 服务端支持按 accountId 过滤及 GET 单条详情，客户端未提供账户过滤/独立转账详情；分页 API 默认50、最大500 |[transfers.ts](../../packages/server/src/routes/transfers.ts)；[transfer-service.ts](../../packages/server/src/services/transfer-service.ts)|
| T008 | 回收站只显示服务端返回的软删除账单，不含工资、规则、转账、物品；每行显示备注、日期、金额 |[TransfersTrashTabs.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransfersTrashTabs.kt)；[trash.ts](../../packages/server/src/routes/trash.ts)|
| T009 | 单项恢复直接 POST，无确认框；恢复幂等，已恢复返回同账单，删除不存在则404；成功重新 GET 回收站 |[TransfersTrashTabs.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransfersTrashTabs.kt)；[transaction-service.ts](../../packages/server/src/services/transaction-service.ts)|
| T010 | 单项“永久删除”需要确认；只允许已软删除账单，删 live账单409；永久删除前清除该账单参与的退款关联，不可恢复 |[TransfersTrashTabs.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransfersTrashTabs.kt)；[transaction-service.ts](../../packages/server/src/services/transaction-service.ts)|
| T011 | “全部恢复”确认后 restore-all，作用于所有已删账单而不只是目前显示行；服务端返回 restored/remaining，UI 只刷新列表 |[TransfersTrashTabs.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransfersTrashTabs.kt)；[transaction-service.ts](../../packages/server/src/services/transaction-service.ts)|
| T012 | “彻底清空”确认后 DELETE /trash，作用于全库软删除账单，先删相关退款链接；服务端返回purged/remaining，UI只刷新列表 |[TransfersTrashTabs.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransfersTrashTabs.kt)；[transaction-service.ts](../../packages/server/src/services/transaction-service.ts)|
| T013 | 回收站加载、错误、busy禁用按钮；初次加载后无专门手动刷新/重试按钮，无显式空状态文案；listTrash不接受筛选/分页参数 |[TransfersTrashTabs.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransfersTrashTabs.kt)；[LedgerRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/LedgerRepository.kt)|
| T014 | 回收站按删除更新时刻降序，最多返回500条；total为全库删除数，但 Android 忽略total、没有分页，批量确认文案可能误称“所列账单” |[transaction-service.ts](../../packages/server/src/services/transaction-service.ts)；[TransfersTrashTabs.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransfersTrashTabs.kt)|

### 5.4 R：周期规则、生成与待确认

入口：我的 → 管理周期规则；我的 → 待确认周期账单，首页也能打开待确认。规则不直接自动记账，不是后台闹钟/通知/定时服务；实际由客户端显式请求生成，再逐笔确认。

| ID | 当前实际功能、字段或约束 | 证据 |
|---|---|---|
| R001 | 规则列表读取规则+收入/支出分类+账户，展示名称、收支类型、金额、频率/锚点、分类/账户、启用状态；刷新保留旧数据并提示更新失败 |[RecurringRulesTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/RecurringRulesTab.kt)、362–435|
| R002 | 新建/编辑：规则名称、支出/收入、元金额、对应类型分类、账户、daily/weekly/monthly/quarterly/yearly、锚点日期；新建默认支出/每月/今天 |[RecurringRulesTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/RecurringRulesTab.kt)|
| R003 | 切换收入/支出清除旧分类；分类/账户下拉，无有效选项时提示不可保存；锚点用日期选择器，不允许直接文字编辑 |[RecurringRulesTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/RecurringRulesTab.kt)、765–776|
| R004 | 客户端名称非空≤60、金额有效>0、分类/账户已选、日期可解析；服务端创建同类型可用分类/账户校验，锚点≤now+1日缓冲并规范到本地日期，金额正整数分 |[RecurringRulesTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/RecurringRulesTab.kt)；[recurring-service.ts](../../packages/server/src/services/recurring-service.ts)|
| R005 | 保存返回列表；失败保留填写；明确 4xx 允许修正重试，5xx/通用网络异常等不明确结果禁用再次保存，先返回列表刷新核对。UI 虽有 OfflineException 的未提交可重试分支，但 ApiClient 未实现网络预检或抛出该类型，不能保证断网实际进入此分支。脏表单系统 Back/内部取消需“放弃修改/继续编辑”；MyTab 外层顶部“返回我的”直接关闭子页，可绕过该确认 |[RecurringRulesTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/RecurringRulesTab.kt)、779–796；[MyTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/MyTab.kt) closeSection/顶部返回；[ApiClient.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiClient.kt)|
| R006 | 启用/停用只能在服务端确认后更新开关；操作失败保持旧状态并暂停相关操作直到刷新；减少动态模式使用文字启用/停用按钮 |[RecurringRulesTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/RecurringRulesTab.kt)|
| R007 | 服务端新建默认 enabled=true；重新启用重置游标到今天之后的下一到期日，停用期间历史不会补齐；现有 pending没有因停用自动删除 |[recurring-service.ts](../../packages/server/src/services/recurring-service.ts)|
| R008 | 删除规则需确认，软删除规则及其未处理 pending；已确认账单、已确认/忽略 occurrence历史保留；删除结果不确定需刷新核对后操作 |[RecurringRulesTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/RecurringRulesTab.kt)；[recurring-service.ts](../../packages/server/src/services/recurring-service.ts)|
| R009 | 修改锚点会重置下一发生日期游标；已生成 pending 是当时类型/金额/分类/账户/名称的快照，不随未来规则编辑自动覆盖 |[recurring-service.ts](../../packages/server/src/services/recurring-service.ts)|
| R010 | 打开待确认、刷新与已处理后先 POST generate，再 GET pending；生成幂等按(ruleId, plannedDate)去重，第一到期日为锚点，生成至服务端今天 |[PendingTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/PendingTab.kt)；[recurring-service.ts](../../packages/server/src/services/recurring-service.ts)|
| R011 | 超期只保留每条规则最近12个到期周期；更旧周期丢弃，hasOlderDue/truncated提示；游标推进到今天之后，反复刷新不会继续补旧周期 |[recurring-service.ts](../../packages/server/src/services/recurring-service.ts)、414–420|
| R012 | 待确认列表 oldest first、不分页、不筛选；每项备注（一般规则名）、收入/支出、计划日期、金额、分类与账户、待确认标签；服务端返回总项数 |[PendingTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/PendingTab.kt)；[recurring-service.ts](../../packages/server/src/services/recurring-service.ts)；[recurring.ts](../../packages/server/src/routes/recurring.ts)|
| R013 | 列表补充分类/账户名失败仍保留 pending，标记不可确认；分类/账户当前不可用时确认禁用，忽略仍可执行 |[PendingTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/PendingTab.kt)、479–493|
| R014 | 单项确认先弹窗核对名字/金额/日期/分类/账户；确认入账按 occurrence快照创建账单，影响财务页；已确认重复请求返回created=false而不新增 |[PendingTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/PendingTab.kt)；[recurring-service.ts](../../packages/server/src/services/recurring-service.ts)|
| R015 | 单项忽略需确认；不生成账单、从待确认移除；重复忽略幂等；确认已忽略/忽略已确认均409 |[PendingTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/PendingTab.kt)；[recurring-service.ts](../../packages/server/src/services/recurring-service.ts)|
| R016 | 操作不明确不先删列表，不重新提交；“刷新核对”只 GET pending，看目标是否已移除；确认的total重新GET前标为旧数，加载/生成/读取错误分开，保留旧内容 |[PendingTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/PendingTab.kt)、279–331|
| R017 | 没有批量确认/批量忽略/确认时改金额日期/系统提醒/单条详情页；确认后只提示关联页面刷新更新 |[PendingTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/PendingTab.kt)|
| R018 | API 可读取所有 occurrence（pending/confirmed/ignored）历史但客户端 repository/界面未调用；规则下一日期与 hasOlderDue 在 DTO中，不等于客户端完整历史管理 |[recurring.ts](../../packages/server/src/routes/recurring.ts)；[BudgetRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/BudgetRepository.kt)；[recurring-service.ts](../../packages/server/src/services/recurring-service.ts)|

### 5.5 API 对照表

全部端点以 `/api/v1` 为前缀，需要会话；写操作经客户端统一请求头。表中的“界面”只表示源码调用路径存在，不表示设备验收通过。

| 方法 | 相对路径 | 输入/输出要点 | Android 状态 |
|---|---|---|---|
| GET | /export/transactions.csv | 含退款标志的账单 CSV | D001 |
| GET | /export/salaries.csv | 工资/账户/分配快照 CSV | D002 |
| GET | /export/recurring.csv | 周期规则 CSV | D003 |
| GET | /export/transfers.csv | 转账 CSV | D004 |
| POST | /import/transactions | text/csv → inserted/skipped/total | D009–D011 |
| POST | /import/transfers | text/csv → inserted/skipped/total | D012 |
| POST | /import/platform-bills | fileBase64/source/dryRun/fileName/selectedIds/categoryOverrides → rows、计数/金额/warnings | D014–D022；也支持服务端 raw输入/手动source，但客户端未暴露 |
| GET | /backups | items:fileName/sizeBytes/createdAtMs | D023 |
| POST | /backups | 创建快照 → fileName/sizeBytes/createdAtMs | D024 |
| GET | /items | status/category/q/limit/offset → items,total,limit,offset | I001–I003；category未暴露 |
| GET | /items/summary | 状态数量/累计购入额/当前日均成本 | I004、I024 |
| GET | /items/:id | 全部物品DTO | I011；展示字段有缺口 |
| POST | /items | I006字段 → 201物品 | I006–I008 |
| PATCH | /items/:id | editable字段 → 物品；重开支持 | I006–I008、I025 |
| DELETE | /items/:id | 软删除 →204 | I022 |
| POST | /items/:id/sell | closedDate,salePriceCents?,saleTransactionId? | I021；服务端售出价可空，UI必填 |
| POST | /items/:id/retire | closedDate | I021 |
| PUT | /items/:id/photo | JPEG/PNG/WebP二进制 →204 | I013–I014 |
| GET | /items/:id/photo | 已存图像二进制/认证/no-store | I011、I014 |
| DELETE | /items/:id/photo | 删除照片 →204 | I015 |
| POST | /items/cutouts | image/webp、image/jpeg、image/png →202{jobId}；2026-11-06复核服务端新增JPEG/PNG供iOS原生照片调用，Android仍按I016压缩WebP；2MiB/像素及归属校验不变 | I016 |
| GET | /items/cutouts/:jobId | jobId/state/message/candidates | I017 |
| DELETE | /items/cutouts/:jobId | 取消/清理 →204 | I018–I019 |
| GET | /items/cutouts/:jobId/candidates/:candidateId/preview | WebP预览 | I017 |
| GET | /items/cutouts/:jobId/candidates/:candidateId/image | 透明PNG | I018 |
| GET | /transfers | accountId?/limit/offset →items,total,limit,offset | T001、T007 |
| GET | /transfers/:id | 单条转账 | 仅服务端，客户端无独立详情 |
| POST | /transfers | fromAccountId/toAccountId/amountCents/date/note →201 | T003–T004 |
| PATCH | /transfers/:id | 同字段部分更新 | T005 |
| DELETE | /transfers/:id | 软删除 →204 | T006 |
| GET | /trash | 最近最多500行+全库total | T008、T014 |
| POST | /trash/:id/restore | 恢复并返回账单 | T009 |
| DELETE | /trash/:id | 永久删除 →204 | T010 |
| POST | /trash/restore-all | restored/remaining | T011 |
| DELETE | /trash | purged/remaining | T012 |
| GET | /recurring/rules | items完整规则 | R001 |
| POST | /recurring/rules | name/type/amountCents/categoryId/accountId/frequency/anchorDate/enabled? →201 | R002–R004；enabled不在创建表单 |
| PATCH | /recurring/rules/:id | 规则editable字段 | R005、R009 |
| POST | /recurring/rules/:id/enabled | {enabled:boolean} | R006–R007 |
| DELETE | /recurring/rules/:id | 删除规则与未处理项 →204 | R008 |
| POST | /recurring/generate | created/truncated/pending | R010–R011 |
| GET | /recurring/pending | items,total | R012 |
| GET | /recurring/occurrences | 所有非删发生历史 | R018，仅服务端 |
| POST | /recurring/occurrences/:id/confirm | transaction,created | R014 |
| POST | /recurring/occurrences/:id/ignore | occurrence | R015 |

<a id="assistant"></a>
## 6. AI 助理、Provider、工具和接口

**2026-11-05 A041/A056/A060 所有权复核：** AI 连接、保存密钥和对话属于当前账号；客户端仍调用既有 `/ai/config` 等路径，不传用户选择器。新用户独立配置模型；登录账号变化重建主界面与配置草稿，服务端会话决定实际账本，管理员身份不授予读取他人 AI 配置的权限。原有配置字段、空密钥保留、模型拉取与测试语义不变。

### 6.1 Android 可见功能（A001–A037、A105–A106）

本节 A015–A031 多文件融合批次导入基础实现源码核对日期：2026-10-17（本地源码核对与自动化测试，未设备/真机实测）；T09 对 A001/A005/A007/A015/A022/A024/A025/A030/A104 及其导入接线专项复核日期：2026-10-31（本地源码复核与回归用例更新；Android JVM结果待门禁复跑，SAF、A/B会话、弱网及真实Provider仍待设备/服务验证）；A005/A010–A014/A033 流式相关源码复核与真机专项实测日期：2026-10-16；A105–A106 智能整理旧账及超时断点继续核对日期：2026-10-23（本地源码、JVM 单测、构建；未设备/真实 Provider 实测）；其余条目保留原审计证据，未验证项严禁写通过。

| ID | 功能与实际规则 | 证据文件:行 |
|---|---|---|
| A001 | AI 助手从“我的→更多工具”作为有来源记录的二级聊天入口；会话管理、全屏导入、分类编辑及全屏二次确认隐藏底栏；新多文件导入统一接入人工导入宿主，不再通过通用聊天“发送”触发隐式 AI 模型调用；旧单文件卡与普通聊天附件流程保留；批次/旧平台导入仅在服务器明确 confirmed 后调用 onDataChanged 使 ledgerRefreshToken 失效，普通聊天发送不发成功信号 |[MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt)、[MyTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/MyTab.kt)、[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)、[PlatformImportHost.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/imports/PlatformImportHost.kt)|
| A002 | 显示 AI 尚未配置、已配置但关闭、已启用、读取失败；启用状态不等于连接已测试 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)|
| A003 | 读取服务器对话列表并默认选择首项；一级页只显示聊天、会话管理/新建入口；会话列表独立全屏；无消息欢迎的4快捷仅填草稿 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)|
| A004 | 新建对话，请求不带自定义标题；服务器返回 ID 后选中；列表重取 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)；[AssistantRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/AssistantRepository.kt)|
| A005 | 切换对话清空旧消息并重读；请求 generation + 当前对话 + 服务地址/当前 Compose 生命周期核对，拒绝同ID旧响应和 A→B→A旧快照；彻底移除全局 composerBatchFiles；新平台导入以 FinancialScope + ApiRequestIdentity + source/入口conversation构成 owner，workspaceRef 保留创建批次的协议conversationId，picker读取/创建/重读/审核/确认及finally用owner+ticket守卫；未决batch重试复用同一clientRequestId和完全相同的文件名/顺序/bytes，拒绝换原件同key；未知分析态只查询，不按failed重触发。实机经会话管理新建独立会话验证：切入B完全隔离（B消息=0、代次=0），切回A对齐同generation（无第二代次，无双泡）；离开A服务端代次持续running；模型代次因上游超时/语法错误未能产出成功答复，生命周期隔离达标但生成失败 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)、[PlatformImportState.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/imports/PlatformImportState.kt)、[PlatformImportHost.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/imports/PlatformImportHost.kt)、[AssistantBatchImportWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchImportWorkspace.kt)|
| A006 | 刷新当前对话、列表加载失败重试、消息读取失败重试；保留服务器可重读数据 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)|
| A007 | 按对话保存文本、单附件、requestId 的易失内存草稿；多文件账单选中文件从聊天通用草稿移出，校验后进入统一 PlatformImportHost 人工工作区；旧单附件与普通chat send保持原流程；只有导入服务器明确确认后才使现有ledgerRefreshToken失效，普通聊天发送/取消/未知结果不报导入成功；全屏会话/导入/分类/确认均不卸载父聊天状态；不承诺跨Tab/进程恢复 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)、[PlatformImportHost.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/imports/PlatformImportHost.kt)、[MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt)|
| A008 | 用户文本输入最多显示 4 行；无客户端长度阻止，服务端限制 2,000 字符 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)；[assistant.ts](../../packages/server/src/routes/assistant.ts)|
| A009 | 文本非空或附有文件即可发送；发送中禁止该对话重复发送/改草稿/附件操作 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)|
| A010 | UUID clientRequestId 随相同草稿保留；编辑文本或更换附件会重置；generation依请求ID+规范化输入hash去重，冲突409；服务端own-answer NULL修复上线（patch 31bb967e），实机新会话验证Choice A -> Question B -> Choice B继续成功，无409 STALE；旧卡（863a936c/ccf489cb）保持已答不修复；普通文本输入作为supersede正常推进 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)；[assistant.ts](../../packages/server/src/routes/assistant.ts)|
| A011 | AI 流式对话与交互式追问协议 v1：纯文本发送经 POST /generations 建立流式 turn，通过 streamSse 接收 state/text-delta/message/terminal 事件增量显示成长气泡；带附件保留 legacy API；可点击停止生成（POST /cancel 取消服务端，返回终态取消）；页面离开仅取消订阅不中断模型；支持追问单选（2–6 项，>=48dp，点击锁定防重复且不记账）与自由输入；状态徽章区分连接中/实时流式/待确认分类追问/待核对记账草案/回答已结束/失败/已停止/连接中断核对；断流通过 GET snapshot 状态核对不盲目重 POST。实机真机验证：首字等待TTFT阶段占位气泡与Stop可用，点击后及时取消（cancelled，零delta零消息，3.5s静默无迟到卡）；真实provisional正文多帧增长（35帧原生screencap，~450ms采样）后由final single bubble原子接管去重；占位标题“● 流式生成中 · 结构化草案”为UI沿用文案，信息类问答不代表已生成财务草稿 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)、[AssistantRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/AssistantRepository.kt)、[AssistantStreamReducer.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantStreamReducer.kt)、[AssistantStreamingComponents.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantStreamingComponents.kt)|
| A012 | generation接受后展示服务器userMessage及部分正文；message事件同ID替换，terminal后刷新历史；流式连接EOF缺终态转核对，不自动重发模型；附件保留原消息流程。实机实测terminal后单气泡接管，全屏无双泡 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)|
| A013 | 消息安装核对最新 generation 和当前目标；旧GET不会覆盖新发送/确认刷新；旧send成功仅清其原requestId草稿，不安装到别的对话；阅读旧内容有跳到最新 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)|
| A014 | 首次载入/实际贴底时跟随新增内容；长气泡使用几何边界与用户滚动状态判定，阅读历史不强抢；手动跳到最新适配减少动态。滚动药丸经 snapshotFlow Triple(newMessagesAvailable, atBottom, isScrollInProgress) 修复与独立 review PASS；实机真机实测（phone-verifier-scroll-live-retest）：流式期间上滑阅读历史触发“有新消息，跳到最新”药丸出现，04-terminal 位于底部边缘但未真到底仍保留药丸（count=1），随后 06-scroll-bottom 自然滑到真底部后药丸自动消失（count=0，未点击药丸）；35 帧短截图（~400ms 采样周期）；总 event payload bytes（19294 字节）非正文字符数（用户 210+助理 2152 字符）；无双泡残留 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)、[AssistantConversationHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantConversationHelper.kt)|
| A015 | 系统选单附件（历史单文件）或多选1–5个账单文件（融合导入批次），显示文件名及大小；多文件原件限额校验后进入统一Host；异步文件读取以原会话/owner/request ticket核验，切换/销毁后不接收；picker取消不改草稿、不发网络；原始字节仅在内存中处理，不持久化保存到磁盘 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)、[PlatformImportHost.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/imports/PlatformImportHost.kt)、[DocumentFiles.kt](app/src/main/java/com/yansuu1/jizhang/ui/DocumentFiles.kt)|
| A016 | 文件格式与限额：历史单文件导入与传统接口保持单文件非空CSV/XLSX、≤5MiB；多文件融合批次导入接受1–5个CSV/XLSX文件，单文件≤5MiB且批次总计≤8MiB（Fastify批次路由专属12MiB请求上限，全局维持8MiB）；微信XLSX与支付宝CSV由服务端自动识别解析，Android source固定auto，界面无手动来源切换 |[DocumentFiles.kt](app/src/main/java/com/yansuu1/jizhang/ui/DocumentFiles.kt)；[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)；[assistant.ts](../../packages/server/src/routes/assistant.ts)；[import-batches.ts](../../packages/server/src/routes/import-batches.ts)|
| A017 | 对话附件输入：传统对话消息发送一次附单个文件；账单导入入口支持多选1–5个账单文件作为融合批次发送；无相机、照片、音频、PDF或通用文档AI分析入口 |AssistantComposerDraft；[DocumentFiles.kt](app/src/main/java/com/yansuu1/jizhang/ui/DocumentFiles.kt)；[assistant.ts](../../packages/server/src/routes/assistant.ts)|
| A018 | 消息区显示用户/助理/工具的内容，文本、progress、error、attachment、result、tool-card以及融合批次导入卡（ImportBatchCard，文本消息附带content.importBatch结构）；文本按普通 Text 显示 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)|
| A019 | 无正文的历史 complete 进度不再占卡（结束不等于入账）；running/failed/未知状态紧凑提示，失败只按安全错误码显示一次说明，不渲染原始错误正文；附件显示文件名 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)|
| A020 | 结果卡显示服务端 summary 和最多 6 个白名单摘要字段，递归对象最多深度 2，不遍历数组；金额明确带 ¥，类型 0/1 展示支出/收入，日期按有效 ISO 或毫秒时间戳格式化。2026-11-06复核：服务端每次成功读取即独立保存 result 卡，后续回答可复用累计事实；Android沿用既有卡展示。新资金/目标/物品/统计/整理读工具的列表、比例、证据数组及 hasMore 等仍未有完整通用展示，不能视为已提供全部结果的核对页。 工作区契约复核（2026-11-06）：服务端支持结构化分页选择、原生入口及任务状态；Android 未声明 workspace-v1，也没有这些选择/路由/草案编辑 UI，不能据此宣称聊天工作区已接入。 Native completion result data.nativeCompletion carries verified outcome metadata bound to the original message/task; Android retains its limited generic summary and does not consume this continuation protocol. |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)、[AssistantConversationHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantConversationHelper.kt)；[assistant-generation-runner.ts](../../packages/server/src/services/assistant-generation-runner.ts) |
| A021 | 工具卡与导入卡：保留操作名/toolName/摘要/影响数/warnings，values与非导入preview可展开递归操作详情。2026-11-05复核：除platform-import.prepare专用分支外，Android没有封闭toolName白名单；新增业务工具可使用现有pending卡、二次确认和取消，详情仍是字段路径文本而非专用领域表单。单文件导入卡打开历史全屏工作区；融合批次导入卡展示文件数、融合记录数与分析状态并打开多文件工作区。 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)、[AssistantBatchImportWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchImportWorkspace.kt)|
| A022 | 操作与批次状态：传统操作状态有 pending / confirmed / cancelled / expired；融合批次分析状态包含 idle / running / complete / failed，未知wire状态在Repository保留为unknown并提供GET查询，不映射成可重试failed；批次终态confirmed/cancelled/expired阻止变更；确认只有matched conversationId/batchId、status=confirmed及完整结果时才发成功回调 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)、[AssistantRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/AssistantRepository.kt)、[AssistantBatchImportWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchImportWorkspace.kt)|
| A023 | 全屏二次核对与权威审核：单文件全屏核对收支合计/退款标签/现有分类/审核备注；融合批次采用两阶段核对，POST review返回服务端权威计算的收支合计（毛支出/毛收入/退款收入/净额）、文件分布、分类新建与复用计划（categoriesToCreate/categoriesToReuse）及已选行清单（`selectedRows`），支持展开逐行检查。每行完整渲染：服务端 `categoryType`（0支出/1收入）、分类名、拟新建徽章（`approvedNewCategoryName != null` 标注“拟新建”）、逐笔备注精准保留（服务端空字符串 `""` 明确保留为 `(空备注)`，不回退为草稿或占位符）；权威统计（`ReviewSummary.counts`）严格区分 `ruleIgnored`（规则忽略）与 `userExcluded`（用户主动排除，可空，为 null 时独立展示为“未提供”，绝不回退为 0），保留服务端原始财务金额不作前端重算；0选择禁止确认，返回不写账 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)、[AssistantBatchImportWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchImportWorkspace.kt)|
| A024 | 提交载荷与指派覆盖：单文件导入传非空显式selectedIds（1–100）及行覆盖；融合批次导入传显式selectedItemIds（1–500）、分类指派、备注覆盖和已批准新分类及冲突决策。普通业务工具二次确认只提交既有 actionId；其参数由服务端待确认草案冻结，不因新toolName要求Android重组财务payload。未知结果需刷新核对。2026-11-05复核：当前onDataChanged仅在确认成功的导入分支调用，普通业务工具确认后刷新聊天但不保证其他已打开业务页立即更新。 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)；[AssistantRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/AssistantRepository.kt)；[AssistantBatchModels.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchModels.kt)|
| A025 | 取消与防护：待确认操作与融合批次均可显式取消（POST cancel）；取消未确认批次不影响已入账账单；请求进行中加锁防重并发；离开工作区时自动取消分析轮询协程，不中断服务端分析进程；代次凭证与401作用域守卫防止跨会话/晚响应回写 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)、[AssistantBatchImportWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchImportWorkspace.kt)|
| A026 | 全屏预览与分页：传统单文件最多前200行预览；多文件融合批次支持全局最多500条记录，手机端采用100条/页的有界分页展示，服务端支持limit/cursor游标；默认提供“待核对”综合筛选（事实冲突、疑似重复/旧账、规则异常、未分配/待批准分类优先排前），另支持全部/已选入/未选/暂不导入/疑似重复/事实冲突/规则排除筛选；“全部”按待核对优先、序号、ID稳定排序；空待核对提示快捷“查看全部 N 条”；行编辑展开“不同来源原备注”（消费 noteAlternatives）并支持采用（含空值写入 noteOverrides 且失效 review）；翻页与筛选完整保留勾选、分类指派与备注草稿 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)；[AssistantBatchImportWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchImportWorkspace.kt)；[AssistantImportState.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantImportState.kt)|
| A027 | 选择、排除与硬锁定规则：初始默认勾选来自AI建议或有效未导入行；AI分析中或失败时不默认选入；明确区分“未选”与“用户排除”（点击“暂不导入”提供即时反馈并更新统计，支持“重新选入”）；硬锁定禁止选入条件为：非正金额（amountCents<=0）、已在账本（existing=true）、账本碰撞（ledger_collision）及批次内弱冲突（weak_collision）；规则忽略原因（如状态非成功等）的非零未入账行保持可选（isEligible=true），用户可自主选入 |[AssistantImportState.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantImportState.kt)；[AssistantBatchModels.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchModels.kt)|
| A028 | 分类指派与新分类批准：传统单文件仅选择现有活跃叶分类；融合批次支持指派现有叶分类，或指派AI/兜底生成的分类建议（suggestionId）；新分类建议包含名称、收支类型及父分类，必须经用户在审核区显式点击批准方可纳入创建计划（多同名叶分类须弹窗显式选定，支持“改名新建”）；确无合适分类时的兜底“其他”新分类建议亦须显式批准；最终仅被选中行引用的已批准建议才会在确认入账时原子创建，未批准或未被选用的建议不创建 |[AssistantBatchImportWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchImportWorkspace.kt)；[AssistantImportState.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantImportState.kt)；[AssistantRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/AssistantRepository.kt)|
| A029 | 规模上限与视图代次隔离：单文件限制200预览/100选择；融合批次限制全局500条记录，超500条整批拒绝不截断，确认最多提交500条；客户端全量数据加载校验version、analysisRevision与viewRevision一致性，代次冲突整批丢弃重试（最多2次），防止混合状态；审核备注≤200字符，显式空字符串表示清空 |[AssistantBatchImportWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchImportWorkspace.kt)；[AssistantImportState.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantImportState.kt)|
| A030 | 原件重传核验与文件运维：确认阶段重新上传批次中全部1–5个原始文件的内存字节，服务端在数据库写事务外重新计算SHA-256摘要、长度并重新解析校验，哈希不符或文件缺失拒绝确认；客户端确认前使用 `matchBatchOriginals` 按服务端 fileIndex + SHA-256 一一对应校验内存原件（同数量但内容变化即判定失配；每份原件只能占用一次），失配时阻断确认并引导重新绑定；批次内解析失败的文件提供单独的[替换]（replace）与[移除]（remove）端点，重新融合更新草稿，阻断未决文件被盲目导入 |[AssistantBatchImportWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchImportWorkspace.kt)；[AssistantBatchRecoveryState.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchRecoveryState.kt)；[AssistantRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/AssistantRepository.kt)|
| A031 | 原件一致性执行与终态清理：原件内容或数量不一致拒绝执行；用户可重新校验或替换原件；批次确认或取消到达终态后，本地清理已选文件列表、行选择草稿、分类覆盖与备注覆盖，释放资源 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)；[AssistantBatchImportWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchImportWorkspace.kt)|
| A032 | 归档有二次确认，说明无恢复列表、清草稿、不删除账本；成功移出列表选下一对话 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)|
| A033 | 对话存储服务端；全屏二级页保留父聊天易失草稿/附件，聊天内部切对话保留；切换底部Tab会卸载聊天，不承诺跨Tab/进程恢复 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)；[AssistantRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/AssistantRepository.kt)|
| A034 | 加载列表/消息、创建、归档、发送、action 执行都有各自 busy 状态与错误提示 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)|
| A035 | 当前有效请求AuthExpiredException回统一登录；生命周期/服务地址不同的晚完成不再回写UI；网络层已有401清Cookie机制本轮未改，不能声称解决晚401的新会话网络竞态 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)、266、289、328、764、888|
| A036 | 消息追加位置有 motion.quickMillis 动画；“跳到最新”适配 reduced；无动画模拟账务变化 |[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)|
| A037 | 归档会使服务端 pending actions expired；无归档列表、取消归档、删除单消息、编辑旧消息、重命名对话 API/UI |[assistant-conversation-service.ts](../../packages/server/src/services/assistant-conversation-service.ts)；[assistant.ts](../../packages/server/src/routes/assistant.ts):API 清单|
| A105 | 智能整理旧账工作区：AI 助手欢迎卡或右上更多菜单进入；本月/上月/近3个月/今年/自定义起止日期；服务端本地日历含首尾日、单次最多 500 笔，超限明确拒绝；带 UUID clientRequestId 与 background: true 异步启动，显式开始后才调用 Provider，支持相同请求幂等重放；真实读取服务端阶段（preparing/analysing/validating/publishing/ready/failed）、批次 X/Y、已处理笔数、已校验建议数（明确标注未应用）与服务端事件时间线，失败展示安全结构字段诊断；完整分析全部批次后才发布审查卡片，失败无部分结果；逐项显示账单日期/金额/收支类型、分类或标签前后值、理由、置信度；点击分类/标签/备注建议卡片复用 L03 居中账单详情弹窗，按完整 transactionId 读取原备注、分类、账户、日期、金额及既有退款关联展示，详情只读且隐藏编辑/退款/删除；复选框独立勾选，关闭详情保留审查列表滚动与已选项；分类/标签动作默认最多选 100 项，备注建议和新建分类建议只展示，预算模板建议不应用；一次明确确认只提交所选项；观察15分钟超时或中断后保留任务编号通过 GET 继续查看，不盲目重复发起；2026-10-23：新任务每批10笔，Provider超时后可明确点击“继续未完成批次（可能产生 AI 调用费用）”，复用私有已校验断点，不重复请求已提交成功批次；同任务最多3次尝试、创建后24小时内可继续，账单/分类/标签/模板变化拒绝继续；旧失败任务无安全断点时须重新分析；只有全部批次成功才生成卡片 |[AssistantOrganizationWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantOrganizationWorkspace.kt)；[AssistantOrganizationModels.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantOrganizationModels.kt)；[AssistantOrganizationState.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantOrganizationState.kt)；[AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt)；[ai-spending-organization-service.ts](../../packages/server/src/services/ai-spending-organization-service.ts)|
| A106 | 整理结果与条件撤销：成功显示 operationId 与已应用动作数；可撤销本次分类/标签改动；服务端条件校验失败时显示冲突且不部分恢复；未知网络结果允许显式重试同一应用/撤销请求，服务端按相同动作幂等处理；不修改原备注、金额、账户、日期、退款事实；模板建议不进入应用 |[AssistantOrganizationWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantOrganizationWorkspace.kt)；[OrganizationRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/OrganizationRepository.kt)；[ai-spending-organization-service.ts](../../packages/server/src/services/ai-spending-organization-service.ts)；[ai.ts](../../packages/server/src/routes/ai.ts) **2026-11-05：** 助理工具侧 `spending.preview`/`spending.resume` 改为后台启动并立即返回 `run`（需 `spending.status` 轮询），Android 直连 `organization-runs` 的既有异步路径不受影响。 |

### 6.2 Provider 设置（A038–A062）

模型拉取/选择及设置页布局重构专项源码核对：2026-10-26，仅本节受影响项及对应API/日志；布局重构不改后端合同，本地测试不等于真机或真实服务商已验证。

| ID | 选项 / 行为 | 证据文件:行 |
|---|---|---|
| A038 | 初始先加载保存配置；未成功加载时禁止保存空配置并给重试按钮 |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)|
| A039 | 启用 AI 服务开关只修改草稿；顶部将服务端已保存启用状态、草稿待保存和显式测试结果分开显示，不将开关草稿宣称为已生效/已连通；保存后才改变服务端状态 |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)|
| A040 | 三种模式：chat-completions / responses / custom，移至连接设置卡与地址就近；切换保留其他字段，不自动重写响应路径和模板 |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)|
| A041 | 基础字段：配置名称、完整请求地址、模型名称；新增“拉取模型”使用服务器已保存地址/密钥，成功后可搜索并点击选择，精确填入模型ID仅改草稿、仍需保存；保留手填/常用模型；空列表或失败不改变当前模型，支持重试 |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)|
| A042 | 认证 none / bearer / header（自定义请求头），移至连接设置卡与密钥就近，保留无密钥none认证 |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)|
| A043 | 新密钥为遮罩密码输入框、留空保留；已保存密钥只展示 hasSecret，不回显明文 |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)|
| A044 | 已有密钥但认证改为 none 时仍保留密钥，提示当前不使用 |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)|
| A045 | 清除已保存密钥必须弹窗；只先标记，保存后才清除；可撤销标记；输入新密钥取消清除标记 |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)|
| A046 | 高级区可展开/收起，按统一 motion tokens 动画、减少动态无 transition |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)|
| A047 | HTTP 方法 GET / POST / PUT / PATCH；非 custom 启用时服务端要求 POST |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)；[ai-config-service.ts](../../packages/server/src/services/ai-config-service.ts)|
| A048 | timeoutMs 默认 20,000，客户端和服务端校验整数 3,000–60,000 |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)、510–515|
| A049 | 额外请求头 JSON 多行输入；本地必须能解析为 JSON 对象，服务端限制 20 个头、名称和字符串值，不允许敏感认证头 |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)；[ai-config-service.ts](../../packages/server/src/services/ai-config-service.ts)|
| A050 | 自定义 JSON bodyTemplate 多行；可引用 input/categories/accounts/model/today/responseSchema/facts，禁止 secret 和未知变量 |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)；[ai-config-service.ts](../../packages/server/src/services/ai-config-service.ts)|
| A051 | responsePath 可手填；非 custom 有“填入当前模式常用路径”按钮：Chat=choices[0].message.content，Responses=output_text |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt) responsePath 输入与 defaultResponsePath（652–656）|
| A052 | header 认证显示自定义认证头名称；客户端阻止空名称；服务端校验有效名称并禁 Cookie/Set-Cookie |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)；[ai-config-service.ts](../../packages/server/src/services/ai-config-service.ts)|
| A053 | 保存按钮提交全部草稿和 clearSecret，secret 仅非空时发送；成功后清空本地 secret / 清除标记 |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)|
| A054 | 配置任意未保存变化或新密钥/清除标记存在则提示并禁“测试已保存配置” |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)、590|
| A055 | 测试只请求服务器已保存配置，不测试当前未保存草稿；有测试中/成功/失败反馈 |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)；[AssistantRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/AssistantRepository.kt)|
| A056 | 保存/测试/拉取模型同步互斥，过程中锁字段，失败保留当前可修改内容；模型列表仅当前页内存，连接/密钥修改失效，服务地址/会话变化拒收迟到结果 |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)、618–620|
| A057 | 采用 Ardot 规范极简重构：首屏聚合 New API / OpenAI 兼容中转站三要素（Base URL 智能补全、API Key 密码眼显隐、常用模型快捷填入），高级配置项折叠收拢；保留手填任意模型与 URL |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)、[ProviderSettingsHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettingsHelper.kt)|
| A058 | 当前 bodyTemplate 读取限制：后端非 custom 模式摘要返回 null；Android 不把不可读字段当清空，未编辑时省略保存该字段 |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)、547–549；[ai-config-service.ts](../../packages/server/src/services/ai-config-service.ts)|
| A059 | 保存后 local 草稿作为 savedDraft；密钥保存在 Compose 普通内存，不写 rememberSaveable；没有离开页面未保存确认 |[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)；文件未使用 BackHandler|
| A060 | 服务端启用配置要求有效 URL/非空 model；首次可关闭AI后保存地址/密钥及空model，再拉取/选择/启用保存；列表支持标准chat-completions/responses末尾路径同源推导/models，custom不支持；列表最多2000原始项/2MiB、ID最长200字符、去重不截断，超时沿用配置且无重试；生产 HTTPS、禁止 URL 用户密码；custom 非 GET 需要 JSON 模板，custom 需要响应路径 |[ai-config-service.ts](../../packages/server/src/services/ai-config-service.ts)|
| A061 | 服务端 AES-256-GCM 保存密钥，随机 12 字节 IV；环境密钥为 64 hex=32 字节；保存/使用密钥需要环境密钥，环境密钥不存数据库 |[ai-crypto.ts](../../packages/server/src/services/ai-crypto.ts)；[ai-config-service.ts](../../packages/server/src/services/ai-config-service.ts)|
| A062 | server config summary 还有 configured/encryptionKeyConfigured/updatedAt；Android provider 页面未展示 encryptionKeyConfigured 与更新时间，只使用 hasSecret 及表单字段 |[ai-config-service.ts](../../packages/server/src/services/ai-config-service.ts)；[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)|

### 6.3 助理工具（保留 A063–A092，新增 A107–A116）

所有工具由服务端 `ASSISTANT_TOOL_NAMES` 与 registry 白名单控制，通过 Android 对话**间接**请求。读/分析工具不写账本；分析可调用 Provider 并保存任务状态，`spending.resume` 只应在用户明确要求继续失败任务时使用。写工具先生成待确认卡，显式确认后才执行。Android 没有工具目录 UI，模型选取和完整任务链仍需真实 Provider 验证。下表保留原稳定 ID；旧“30个工具”是历史统计，A107–A116按业务能力组列出新增工具，不据此改写全库功能/API总数。

| ID | 工具 | 具体能力 / 限制 | 适配器源码行 |
|---|---|---|---|
| A063 | transactions.recent | 最近账单、类型或备注查询，默认 10 / 最多 50 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A064 | accounts.balances | 服务端账户余额 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A065 | budget.overview | 当前/指定 periodStart 的预算概览、模块、结余池 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A066 | stats.monthly | 1–12 个月月度收入与净支出趋势 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A067 | recurring.pending | 待确认周期账单，结果最多 100 项 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A068 | monthly.evaluate | 当前自然月评价：收入、净支出、分类、6 月趋势、当前预算事实；评价使用事实证据 ID |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)；[monthly-evaluation-service.ts](../../packages/server/src/services/monthly-evaluation-service.ts)|
| A069 | organization.preview | 预览安全分类/标签合并动作；语义交易重分类/分类建议仅建议；采样最多 200 笔 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)；[ai-organization-service.ts](../../packages/server/src/services/ai-organization-service.ts)|
| A070 | backups.list | 备份文件名列表，适配器未截断列表 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A071 | backup.export-links | 返回 transactions/salaries/recurring/transfers 四类相对 CSV 导出地址 /api/v1/export/{what}.csv |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A072 | transaction.create | 准备普通收入/支出、整数分金额、日期、分类、账户、备注、tags、isRefund、refundLinkedTxIds，以及四值fundPurpose；退款仍关联原支出并单独计入收入，确认前不入账。 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A073 | transaction.update | 指定账单ID + changes；准备变更前后指纹。四用途变更由服务端冻结operationId、用途revision与transactionToken，确认仍经过原事务/CAS校验。 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A074 | transaction.delete | 将账单移入回收站 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A075 | transaction.restore | 从回收站恢复账单 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A076 | transfer.create | 创建指定转出/转入账户、金额、日期、备注的转账 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A077 | salary.create | 2026-11-05重新接入canonical四用途收入：amountCents/date/accountId/可选note、expectedFundConfigRevision；服务端生成或冻结operationId并提交contractVersion=1，由服务器保存四用途分配快照。不能重复将同一笔钱记成普通收入；旧templateId/allocations载荷仍拒绝。 |[assistant-business-tools.ts](../../packages/server/src/services/assistant-business-tools.ts)、[salary-service.ts](../../packages/server/src/services/salary-service.ts)|
| A078 | category.create | 创建分类，name/type/icon/color/sortOrder/parentId |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A079 | category.update | 修改指定分类 changes |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A080 | category.delete | 分类软删除 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A081 | account.create | 创建账户、type、initialBalanceCents |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A082 | account.update | 修改指定账户 changes |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A083 | account.delete | 账户软删除 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A084 | budget.template.apply（已移除，2026-11-05复核） | 前序canonical资金迁移已退役新建旧分类预算分配；当前白名单无此工具，不恢复“将模板应用到当前周期”。保留稳定ID；模板本身（路由已弃用）见 §4.10 M02。 |[assistant-types.ts](../../packages/server/src/services/assistant-types.ts)、[salary-service.ts](../../packages/server/src/services/salary-service.ts)|
| A085 | backup.create | 服务端创建数据库备份 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A086 | 平台账单确定性预览+配置Provider真实分析+人工审核；显式选择/分类ID/备注覆盖确认入账，原件摘要与当前账本/分类重验；事务/重复确认保护。 | 账单干跑预览；确认后按所选行/分类覆盖导入；原件摘要校验 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A087 | organization.apply | 必须显式提供非空且不重复的actionIds；重验冻结previewHash及确定性事实，确认不再次调用Provider；确认后才应用并写入审计，不再默认选择全部ready动作。 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A088 | organization.undo | 根据 operationId 条件撤销审计操作；有后续变更则拒绝 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)；[ai-organization-service.ts](../../packages/server/src/services/ai-organization-service.ts)|
| A089 | recurring.confirm | 确认指定 occurrenceId |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A090 | recurring.ignore | 忽略指定 occurrenceId |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A091 | tag.rename | 指定 from/to 重命名标签，标签集合指纹防过期 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A092 | tag.delete | 指定 name 删除账单中的标签，指纹防过期 |[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|

#### 2026-11-05 新增业务能力组（A107–A116）

**2026-11-06 工作区局部复核补充：** 下列原稳定 ID 增补服务端工作区契约，不增加 Android 功能编号。证据为 [workspace routes](../../packages/server/src/routes/assistant-workspace.ts)、[workspace service](../../packages/server/src/services/assistant-workspace-service.ts)、[selection/workflow store](../../packages/server/src/services/assistant-workspace-store.ts)、[typed tools/native catalog](../../packages/server/src/services/assistant-workspace-tools.ts)、[daily facts](../../packages/server/src/services/assistant-daily-review.ts)；Android 当前消费边界以 §6.5/9.3 为准。

以下为**服务端工具实现 + Android既有通用确认入口的源码兼容性**，不是新增Android专用编辑器或真机验收。写工具共用预览→用户确认→既有服务事务；预览回滚领域写入，确认重验指纹/CAS及当前用户账本。金额为整数分；域内operationId在草案中冻结或由服务端生成。分页工具以limit（最多100）/offset或既有cursor读取，total/hasMore不可解释成“本页即全部”。证据统一为 [business adapters](../../packages/server/src/services/assistant-business-tools.ts)、[白名单类型](../../packages/server/src/services/assistant-types.ts)、[registry](../../packages/server/src/services/assistant-tool-registry.ts)；完整域覆盖见[本轮工具矩阵](../../.trellis/tasks/11-04-ios-assistant/research/assistant-business-matrix.md)。

| ID | 读/分析工具 | 待确认写工具 | 输入、校验与业务边界 |
|---|---|---|---|
| A107 | `transactions.query`、`transaction.details`、`transactions.daily` | 原A072–A075 | 完整账单筛选含账户/日期/分类/标签及高级搜索；offset分页返回权威total。2026-11-06复核：长备注/理由在列表中摘要并标明截取，单笔备注可用 details 读取更多；超过助手 4,000 UTF-16 单位时返回原长/展示长及省略标记，全文请打开原账单详情；展示体积过大可减少本页实际limit，按nextOffset继续。details的refundDetails/refundLinkedTxIds双向退款关系各有total/offset/limit/nextOffset/hasMore分页元数据，不把一页当全部。daily要求from/to/timeZone，最多32天。普通支出仍为毛额，退款独立记入收入。 服务端 workspace.select 可按真实账单 ID、类型/日期/账户/分类筛选并分页；日期范围使用账本 Asia/Shanghai。revise 返回新 action 并关闭旧草案，确认仍使用原通用接口；Android 聊天未接该选择/编辑交互。 |
| A108 | `master-data.read` | `master-data.move`、`tag.create`、`tag.update`、`tag.remove`；原分类/账户CRUD及tag.rename/delete保留 | kind选择分类/账户/标签层级或引用情况；分页取得真实ID。排序direction仅-1/1；标签name/parentId经现有服务校验。模型不能提供任意SQL或URL。 工作区增加账户/分类/标签的权威分页选择及原任务续接，保留真实层级和 ID；选择本身不修改主数据，Android 仍使用原通用卡及原生管理页。 |
| A109 | `transfers.query`、`trash.list` | `transfer.update`、`transfer.delete`、`trash.restore-all`、`trash.purge`、`trash.purge-all`；原transfer.create/single restore保留 | 转账按id或accountId分页，不计收支；回收站返回total/offset/limit/hasMore，永久删除在确认描述中明确不可撤销。全部恢复/清空是全库当前用户范围的操作，不是仅当前页。 工作区增加 transfer/trash 资源选择，确认后可幂等续接原任务；Android 未接该聊天选择或续接接口。 |
| A110 | `recurring.rules`（view=rules/occurrences/pending） | `recurring.create`、`recurring.update`、`recurring.toggle`、`recurring.delete`、`recurring.generate`；原confirm/ignore保留 | 规则含name/type/amountCents/categoryId/accountId/frequency/anchorDate/enabled；生成只产生待确认记录，不直接记账；后续confirm才写入一次收入或支出。字段校验沿用原服务，更新规则的引用校验差异仍见§9.2。 工作区提供 recurring/recurring-occurrence 真实规则和待确认记录选择；确认后的任务续接不授权下一笔写入。Android 周期页及原通用确认流程未改。 |
| A111 | `funds.read`、`salaries.read` | `funds.configure`、`funds.review`、`salary.update`、`salary.delete`；canonical salary.create见A077 | funds view为summary/config/capabilities/issues；ratiosBps四项合计10000，配置带expectedRevision/timeZone且只影响未来分配；review带grantId（可选）、来源salaryId/expectedSourceToken；工资修改/删除带expectedGrantRevision，不借旧模板重建分配。 工作区增加 salary/fund-source 选择；收入及来源校验事实进入任务状态，改草案仍保留修订校验并重新确认。Android 未增加聊天收入选择器或草案字段编辑页。 |
| A112 | `plan.read`、`plan.preview`、`goals.read` | `plan.save`、`goals.opening`、`goals.create`、`goals.update`、`goals.delete` | 独立计划输入monthlyIncomeCents/essentialMonthlyCents/reserveBalanceCents，保存带revision；目标reserve/investment的期初和deposit/withdrawal进度使用expectedRevision/operationId，支持时间窗/cursor，始终与真实账单分开。 工作区可选择目标并替代待确认草案；计划/目标的账本隔离、revision 和 operationId 约束保持，Android 未接新增交互。 |
| A113 | `items.read` | `item.create`、`item.update`、`item.sell`、`item.retire`、`item.delete` | 列表、概览、id详情和q/category/status/sort分页；物品名/购入日期/可空价格/状态/备注及购入、售出账单关联使用原域校验。物品登记或状态变化不会自动创建收入/支出；照片上传/删除和抠图任务不在该工具组内。 workspace.open 的 item-photo/item-cutout 只返回受信任客户端入口并验证物品 ID；iOS 实现新原生工作区，Android 聊天不处理该 nativeAction，既有物品页入口保持。Android 抠图仍上传 WebP；服务端新增 JPEG/PNG 只是输入兼容扩展。 Photo completion saved/viewed requires the exact current raw-byte SHA256; removed omits it. Verification establishes current matching bytes or absence only, never client causation. Android chat does not return these native receipts. |
| A114 | `settings.read`（`templates.read` 已于 2026-11-05 随分配模板退役移除） | `settings.cycle`（`template.create`/`template.update`/`template.default`/`template.delete` 同日移除） | 周期起始日1–28或null。**2026-11-05 变更：** 助理不再提供任何模板工具，`ASSISTANT_TOOL_NAMES` 同步删除这 5 个名字（保留名字但不注册会让 `catalog()` 抛错）；因此 §6.1 里依赖模板建议的分支恒为空。`/api/v1/templates` HTTP 路由仍存在但已弃用，见 §4.10 与 §11 模板行。不恢复 A084 的“应用到当前周期”。 新原生入口含设置、密码、邀请码、提醒、退出及服务器切换；凭据/文件不进入模型通用参数。每日提醒由 iOS 本机经系统授权安排，Android 未新增提醒或通知，也不恢复模板。 |
| A115 | `stats.query`、`daily.review`、`planning.read`、`planning.preview` | `planning.configure`、`planning.mapping`、`planning.confirm`、`planning.reconcile`、`planning.purpose`、`planning.refund-splits` | 统计复用服务器时间窗/分类毛支出/退款收入/月趋势；2026-11-06复核：指定month且省略kind时查询该自然月，显式kind=last30仍按近30天。旧执行计划按view读取来源/周期/修订/事实/用途/退款/操作。写入保留源hash、revision与服务端计算；单次规则/来源/拆分最多100项；已有规则超过100项时拒绝整组替换，不能静默丢弃其余规则。旧域已退役写入继续由服务端拒绝。 服务端新增 daily.review：按明确日期/Asia-Shanghai 返回完整日收支、工资/退款区分及有覆盖标记的分类/账户拆分。工作区 daily-review 及后续选择/追问保持只读；点击通知后生成属于 iOS 入口，Android 未接通知或该端点。 |
| A116 | `spending.preview`、`spending.card`、`spending.status`、`spending.resume`、`spending.evidence` | `spending.apply`、`spending.undo` | startDate/endDate为YYYY-MM-DD，完整分析最多500笔；resume仅明确要求时继续失败任务，可能再次产生Provider调用。2026-11-06复核：preview/resume/status返回run后结束当轮，保存任务结果并将后续进度交给客户端；后台分析不随正常对话结束而中止，不再用模型循环轮询。card建议分页最多100项并返回totalActions/offset/limit/hasMore；coverage为计数及idsOmitted，完整分类金额证据改用evidence分页。apply要求runId及1–100个明确、唯一、有效actionIds，允许分类/标签/新分类建议，禁止默认全选；note只参考，模板建议已退役。undo遇后续变更拒绝覆盖。Android A105–A106独立整理UI仍只选择分类/标签，新分类建议不自动应用；聊天没有新增任务观察卡、逐项勾选或证据分页控件。 新工作区 organization/card、organization/prepare 和结果分页供直接核对/准备明确选中的 1–100 项；结构整理预览也分页，确定性翻页/准备不额外调用模型。Android 独立整理沿用原接口，聊天未获得跨页选择、直接准备或新任务卡。 |

当前仍不提供模型工具的能力包括照片/抠图上传、任意文件字节/融合导入人工审核替代、主题/密码/邀请码/Provider密钥管理、备份恢复和数据库运维；这些保留专用可信UI或运维入口。旧预算分配写入属于已退役能力。可由工具访问、Android通用卡可提交确认、存在专门移动页面是三种不同能力，不能互相替代。

### 6.4 服务端流程与约束（A093–A104）

本节 A104 及 A101–A103 批次对比相关源码核对日期：2026-10-17（本地源码核对与自动化测试，未部署/未设备实测）；A093于2026-11-06局部源码复核，A094–A100保留原审计证据。

| ID | 能力 / 边界 | 证据 |
|---|---|---|
| A093 | 普通对话最多8次模型决策（包括最终回答），总时限180秒；同工具同参数的重复读取结束当轮并复用已有结果。已知业务参数错误最多给模型2次纠正机会，未知/退役工具、权限、取消、超时等不进入纠错。逐次成功读取立即保存；回复每步最多4,000字符，流式代次累计最多12,000字符。历史context与input均取最近最多20条、每条文本2,000，上下文窗口限128 KiB并明确标记较早内容省略；单次读取投影最多40 KiB，累计已读超过64 KiB时保存结果并结束当轮提示缩小范围。长文本摘要和offset缩页均显式标记，cursor页超限要求缩小查询，不伪造续页；金额、编号、标签与来源hash不因展示而缩写。写操作仍只生成待确认草案，不自动入账；流式财务预览超过单条事件大小时要求缩小选择，不裁掉待确认影响范围。 2026-11-06 工作区复核：代次需显式声明 clientCapabilities=[workspace-v1] 才绑定持久化任务/选择；v1 和 legacy 请求保留原协议。新工作区提供权威选择、替代草案、确认后幂等续接和只读每日复盘；选择不是同意修改，后续写入逐项重新预览/确认。任务事实独立保存，重启/取消/归档与代次和卡片终态核对。Android 未声明该能力或调用新路由。 Native-completions additionally require the completed original workspace.open message/workflow and a closed typed reference. Canonical request and source/reference receipt identities deduplicate continuation; later writes require new consent and daily read-only scope inherits. Android does not call this endpoint. |[assistant-orchestrator.ts](../../packages/server/src/services/assistant-orchestrator.ts)；[assistant-generation-runner.ts](../../packages/server/src/services/assistant-generation-runner.ts)；[assistant-turn-policy.ts](../../packages/server/src/services/assistant-turn-policy.ts)；[assistant-result-projection.ts](../../packages/server/src/services/assistant-result-projection.ts)；[assistant-conversation-service.ts](../../packages/server/src/services/assistant-conversation-service.ts) |
| A094 | 附件先确定性提取事实，再调用已保存Provider分析前200行（每批25行），只接受已知行ID/理由/选入建议/现有同类型分类ID；没有工具执行或金额日期更改。失败明确显示且支持原件匹配的显式重试（新卡、重置旧草稿）；确认不调用AI。 |[assistant-orchestrator.ts](../../packages/server/src/services/assistant-orchestrator.ts)|
| A095 | 写操作预览记录参数、fingerprint、附件元信息；确认时重跑预览比较指纹、原件大小/hash； stale 被置 expired |[assistant-orchestrator.ts](../../packages/server/src/services/assistant-orchestrator.ts)；[assistant.ts](../../packages/server/src/routes/assistant.ts)|
| A096 | 确认操作同 action ID 的并发请求复用 Promise；写入 + 状态 + 消息在 SQLite 事务；已确认重复请求返回既有结果 |[assistant.ts](../../packages/server/src/routes/assistant.ts)；[assistant-orchestrator.ts](../../packages/server/src/services/assistant-orchestrator.ts)|
| A097 | 附件正文永不持久化；对话/消息/pending 卡持久化；归档为 archived=1，pending -> expired |[assistant.ts](../../packages/server/src/routes/assistant.ts):首行；[assistant-conversation-service.ts](../../packages/server/src/services/assistant-conversation-service.ts)|
| A098 | 确认路由、registry与严格导入服务共同限制显式非空1–100行及最多100覆盖；超限拒绝而非静默截断；只能选择前200预览行；未知执行结果须刷新核对。 |[assistant.ts](../../packages/server/src/routes/assistant.ts)；[assistant-tool-registry.ts](../../packages/server/src/services/assistant-tool-registry.ts)|
| A099 | Provider 自定义模板支持有限变量和点/数组下标响应路径；不运行 JS/任意代码；拒绝重定向、2 MiB 响应大小限制 |[ai-provider-service.ts](../../packages/server/src/services/ai-provider-service.ts)|
| A100 | Chat 模式固定 JSON object + temperature 0，Responses 模式固定 JSON object + temperature 0；测试只是成功调用并提取响应，并不验证正常记账完整草稿或所有工具 |[ai-provider-service.ts](../../packages/server/src/services/ai-provider-service.ts)；[ai-transaction-service.ts](../../packages/server/src/services/ai-transaction-service.ts)|
| A101 | 疑似重复行 → 对比现有账单：来源日期/整数分金额/类型/独立退款/账户/来源分类/审核分类/完整来源及审核备注，单号/状态/交易对方按可用事实显示；服务端当前候选完整备注/历史账户分类名称/退款身份；同平台账户、服务端本地同日同类型同金额是线索而非证明。支持历史单文件行与多文件融合批次行对比。 |[AssistantImportWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantImportWorkspace.kt)；[AssistantBatchImportWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchImportWorkspace.kt)；[assistant-import-comparison-service.ts](../../packages/server/src/services/assistant-import-comparison-service.ts)|
| A102 | 对比候选按ID分页（手机20/页，服务端limit 1–50）和总数/读取时间展示；加载、空结果、刷新/失败重试、下一页；打开/关闭不改选择，显式保留/排除只改来源ID，遵守有效未导入（正金额且未入账）/忙碌/未知结果/100行上限；父列表保持挂载，action+row及请求代次隔离晚响应；已关闭操作关闭对比；当前有效对比请求401返回登录，失效请求不触发导航；整数事实拒绝小数/溢出而非截断。 |[AssistantDuplicateState.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantDuplicateState.kt)；[AssistantImportWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantImportWorkspace.kt)|
| A103 | 鉴权GET按conversation/action/前200显示row解析存储事实；取消/替换/归档操作不可读取；候选读不调用AI、不写账本。旧卡缺对比账户等事实要求重上传，候选变化不是确认快照；最终摘要/指纹/原件/事务/幂等保护不放宽，稳定ID硬去重保持。 |[assistant.ts](../../packages/server/src/routes/assistant.ts)；[portability-service.ts](../../packages/server/src/services/portability-service.ts)|
| A104 | 多文件账单融合导入批次（Import Batch）：1–5个CSV/XLSX文件经SAF多选上传，单文件≤5MiB、总大小≤8MiB（Fastify批次专属12MiB上限，内存字节处理）；服务端解析后融合去重分配稳定itemId，整批最多500条待核对记录（超500条整批拒绝不截断）；两阶段review-confirm原子写入，POST review生成快照、reviewToken（15分钟有效）、权威财务总计、分类创建与复用计划、逐行selectedRows（含服务端categoryType与approvedNewCategoryName）及独立typed counts（分离ruleIgnored与可空userExcluded）；POST confirm重传原件多文件内存字节，库外重验SHA-256哈希与长度并重解析，单一SQLite事务内原子创建已批准新分类与记账入账（全成或全败）；失败文件支持行级移除与就地替换重解析；异步分片AI分析（最多20分片，全成或全败，GET不触发模型）推荐现有叶分类或新分类建议（`suggestionId`）；**无新分类自动批准（no new class auto-approve）**：新分类建议默认未批准，必须显式点击批准或改名新建；同名候选叶分类弹窗显式选定；缺失兜底“其他”建议亦须显式批准；仅被最终选中行引用且已批准建议原子创建，未批准或未被选用的建议（categoriesSkippedUnused）不予创建；**选择与排除**：非正金额、已入账、账本碰撞与弱冲突硬锁定禁止选入；规则忽略原因（如status:*）行保持可选（isEligible=true），用户可自主选入；未选行点“暂不导入”即时反馈并更新统计，支持“重新选入”；**分页完整性与混合快照严格有界重试**：全局500条采用100条/页分页展示，纯函数 `validateAndReduceBatchPages` 严格校验5页上限、游标完全耗尽、循环游标拒绝、异常空页拒绝与总数一致（declaredTotal == totalItems == uniqueItemIds.size）；严格非空 viewRevision 守卫，检测到并发代次变动整批放弃并最多重试2次，重试耗尽保留用户手动草稿；只读对比批次行与现有账单；历史单文件200/100导入与卡片取消流程100%兼容隔离；**Reader Identity与真实Wire契约**：reader identityKind 正式严格限制为 `platform_order` 与 `occurrence`，严格拒绝 legacy_order 与 unknown（fail-close 抛异常）；真实 Fastify wire JSON fixture 34 行初测因 platform_order 抛错 FAIL，经生产解码器修复后全量 34 行 PASS；null AI reason 使用 `optCleanString` 映射为空字符串不显示字面 "null"；空备注 "" 精确保留展示为 (空备注)、服务端 categoryType 0/1 逐行投影与 approvedNewCategoryName 拟新建徽章、ReviewSummary.counts 独立解析及 userExcluded 保持 nullable 行为全部通过真实 wire 数据核验；明确仅验证 local 源码与本地真实 route wire fixture，生成 fixture 不等同于真实 Provider/真机，不能说“真实线上协议已验证”；无物理设备安装，无后端部署，真实海量导出 benchmark 缺口保留。 |[AssistantBatchImportWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchImportWorkspace.kt)；[AssistantBatchModels.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchModels.kt)；[import-batches.ts](../../packages/server/src/routes/import-batches.ts)；[import-batch-service.ts](../../packages/server/src/services/import-batch-service.ts)|

### 6.5 API 覆盖矩阵

**2026-11-06 native-completions (backend/iOS only):** POST /assistant/conversations/:cid/workspace/native-completions accepts {clientRequestId,sourceMessageId,reference} and returns {created,generation,workflow},202 new/200 replay. Reference is exactly csv-import{previewId}, platform-import{batchId}, item-photo{itemId,operation:saved|viewed,sha256}, item-photo{itemId,operation:removed}, or export{exportKind:transactions|salaries|recurring|transfers}. IDs are nonblank <=120 units; photo SHA256 is64 lowercase hex over exact raw bytes. Unknown fields/kinds fail400. The owned completed workspace.open source must match destination/item; CSV/batch confirmation time must be >=source time. Unconfirmed/older/null-time legacy CSV receipts or changed photos fail409; foreign source/batch/receipt fails404. Committed replay returns the same generation even if current state later changes. Photo proof is current-state, export proof is current server generation only (not device save/OS Share). Credentials/provider-settings/logout/server-switch have no completion reference. No file bytes/secrets/client prose are accepted as proof. Android has no Repository method or UI for this contract; its existing import/confirm flows remain unchanged.

**2026-11-06 `workspace-v1` 增量：** 以下新增端点仅为后端/iOS 工作区接入，Android 没有对应 Repository 方法或 UI。原 v1 messages/generations/confirm/cancel 保持；新客户端在 generations 请求中显式发送 `clientCapabilities:["workspace-v1"]`，旧请求不因此升级成新选择/任务协议。选择、草案修改和确定性翻页不等于确认；新草案有新 action ID，旧草案关闭；确认后续接沿用冻结的原任务和请求身份，每一笔后续写入仍需单独确认。受信任 nativeAction 仅是入口描述，不授予服务端权限，也不把密码、密钥或文件内容交给模型。

2026-11-05工具扩展**没有新HTTP路由**：文本与流式调用继续使用下表既有messages/generations，所有新写工具仍经过`/assistant/actions/:id/confirm`或`cancel`；v1 card/result不改版。`GET /assistant/tools`包含新的服务端白名单，Android仍无目录请求/UI。业务域原HTTP端点并未因此自动增加Android原生页面。

2026-11-06可靠性修复继续沿用这些路由。后台历史整理结果保存为现有result消息；读取既有`/ai/organization-runs/:id`进度及`/:id/card`建议不调用模型，显式resume仍可能调用模型。Android聊天当前仅显示通用结果摘要，自动GET观察仍是A105–A106独立整理工作区的能力，未新增聊天任务观察入口。

| API | Android 实际入口 | 可用程度 |
|---|---|---|
| GET /assistant/conversations/:conversationId/actions/:id/rows/:rowId/duplicates | 导入工作区疑似重复行→对比现有账单；A101–A103 | 源码接入/自动测试与构建；设备待验 |
| GET /assistant/tools | 无 Repository 方法/UI | 仅后端 catalog |
| GET /assistant/workspace/capabilities | 无 Android 方法/UI | 仅后端/iOS 能力与受信任原生入口目录，权限仍由实际入口/服务器检查 |
| POST /assistant/data-import/preview | 无 Android 方法/UI；Android 原 Data CSV 流程不变 | 仅后端/iOS 通用 CSV 干跑预览，原文件不进入模型 |
| POST /assistant/data-import/:id/confirm | 无 Android 方法/UI | 仅后端/iOS 原 CSV 哈希、账本快照和预览 ID 核对后幂等确认 |
| GET /assistant/conversations/:id/workspace | 无 Android 方法/UI | 仅后端/iOS 原任务阶段/恢复状态 |
| GET /assistant/conversations/:id/workspace/interactions/:interactionId | 无 Android 方法/UI | 仅后端/iOS 权威分页/搜索选择卡 |
| POST /assistant/conversations/:id/workspace/interactions/:interactionId/answer | 无 Android 方法/UI | 仅后端/iOS 原卡身份、成员/快照及原请求重放；选择不修改账本 |
| GET /assistant/conversations/:id/workspace/actions/:actionId | 无 Android 方法/UI | 仅后端/iOS 待修改草案及可编辑参数描述 |
| POST /assistant/conversations/:id/workspace/actions/:actionId/revise | 无 Android 方法/UI | 仅后端/iOS 新预览替代旧 action，仍待用户确认 |
| POST /assistant/conversations/:id/workspace/actions/:actionId/continue | 无 Android 方法/UI | 仅后端/iOS 已确认操作的幂等续接，不重复确认原操作 |
| POST /assistant/conversations/:id/workspace/results/:messageId/page | 无 Android 方法/UI | 仅后端/iOS 沿原筛选读取下一页，不假定本页是全部 |
| POST /assistant/conversations/:id/workspace/organization/card | 无 Android 方法/UI | 仅后端/iOS 读取已有整理建议；Android A105/A106 仍用原组织运行接口 |
| POST /assistant/conversations/:id/workspace/organization/prepare | 无 Android 方法/UI | 仅后端/iOS 直接准备明确选中的建议，不额外推理或自动应用 |
| POST /assistant/conversations/:cid/workspace/native-completions | No Android Repository/UI | Backend/iOS only; verified typed native outcome resumes the original task once,202 new/200 replay; later writes still need separate consent |
| POST /assistant/conversations/:id/workspace/daily-review | 无 Android 方法/UI或通知入口 | 仅后端/iOS 固定日期/Asia-Shanghai 只读复盘，点击通知才请求生成 |
| GET /assistant/conversations/:id/generations/:genId/trace | 无 Android 方法/UI | 仅后端/iOS 有界步骤元信息；历史参数值在读边界脱敏，不展示模型隐藏推理 |
| GET /assistant/conversations | 对话列表 | 已接入 |
| POST /assistant/conversations | 新对话 | 已接入；不发送 title |
| GET /assistant/conversations/:id/messages | 切换/刷新 | 已接入；全量返回，无分页 |
| POST /assistant/conversations/:id/messages | 文本/账单附件发送 | 已接入；带附件走此接口非流式 |
| POST /assistant/conversations/:id/generations | 新流式 generation 创建/幂等重放 | 已接入（协议 v1，纯文本/选项输入） |
| GET /assistant/conversations/:id/generations | 获取最近 generation 快照 | 已接入 |
| GET /assistant/conversations/:id/generations/:genId | 获取指定 generation 快照 | 已接入 |
| GET /assistant/conversations/:id/generations/:genId/events | SSE 流式事件增量读取 | 已接入（有界流、断流核对） |
| POST /assistant/conversations/:id/generations/:genId/cancel | 显式停止生成 | 已接入（停止按钮触发） |
| DELETE /assistant/conversations/:id | 归档弹窗 | 已接入；无恢复 |
| POST /assistant/actions/:id/confirm | 卡片二次确认；A021/A024及A107–A116通用业务草案 | 已接入通用提交，无工具名封闭白名单；复杂结果展示/跨页刷新缺口见§9.3 |
| POST /assistant/actions/:id/analyse | 原件匹配后显式重试AI分析，生成新审核卡 | 源码接入，未设备/真实Provider验证 |
| POST /assistant/actions/:id/cancel | 既有及新增业务草案卡片取消 | 已接入；仅pending允许操作，仍由服务端校验所有权/状态 |
| POST /assistant/conversations/:conversationId/import-batches | 对话附件选 1–5 个账单文件发送，创建/重放融合批次；A015–A017, A104 | 源码接入/单元与契约测试通过；设备待验 |
| GET /assistant/conversations/:conversationId/import-batches/:batchId | 打开批次工作区读取批次主状态、文件与统计；A021, A104 | 源码接入/单元与契约测试通过；设备待验 |
| GET /assistant/conversations/:conversationId/import-batches/:batchId/rows | 工作区有界分页与筛选读取融合账单行；A026, A104 | 源码接入/单元与契约测试通过；设备待验 |
| GET /assistant/conversations/:conversationId/import-batches/:batchId/rows/:itemId/duplicates | 批次行疑似重复对比弹窗；A101–A104 | 源码接入/单元与契约测试通过；设备待验 |
| GET /assistant/conversations/:conversationId/import-batches/:batchId/categories | 读取活跃叶分类与新分类建议；A028, A104 | 源码接入/单元与契约测试通过；设备待验 |
| POST /assistant/conversations/:conversationId/import-batches/:batchId/review | 审核面板提交已选行、指派与批准，获取权威摘要与令牌；A023, A104 | 源码接入/单元与契约测试通过；设备待验 |
| POST /assistant/conversations/:conversationId/import-batches/:batchId/analyse | 异步发起/重试AI分类建议分析；A022, A104 | 源码接入/单元与契约测试通过；设备待验 |
| POST /assistant/conversations/:conversationId/import-batches/:batchId/files/:fileIndex/remove | 移除批次中指定失败文件并重新融合；A030, A104 | 源码接入/单元与契约测试通过；设备待验 |
| POST /assistant/conversations/:conversationId/import-batches/:batchId/files/:fileIndex/replace | 替换批次中指定失败文件并重新融合；A030, A104 | 源码接入/单元与契约测试通过；设备待验 |
| POST /assistant/conversations/:conversationId/import-batches/:batchId/confirm | 原件多文件重传校验，原子写入分类与账本；A023, A030, A104 | 源码接入/单元与契约测试通过；设备待验 |
| POST /assistant/conversations/:conversationId/import-batches/:batchId/cancel | 显式取消批次；A025, A104 | 源码接入/单元与契约测试通过；设备待验 |
| GET /ai/config | AI 状态/设置加载 | 已接入，但 encryptionKeyConfigured/updatedAt 未显示 |
| PUT /ai/config | 保存设置 | 已接入，secret 写入/保留/清除 |
| POST /ai/test | 测试已保存配置 | 已接入 |
| POST /ai/transaction-draft | 无直接 Android 入口 | 服务端草稿接口存在；Assistant transaction.create 是不同写入流程 |
| POST /ai/monthly-evaluation | 无直接 Android 入口 | 可经 monthly.evaluate 间接调用，结果展示有限 |
| POST /ai/organization-preview | 无直接 Android 入口 | 可经 organization.preview 间接调用，不能完整浏览建议/动作 |
| POST /ai/organization-apply | 无直接 Android 入口 | 可经 organization.apply 间接调用，无整理动作 checkbox UI |
| POST /ai/organization-undo | 无直接 Android 入口 | 可经 organization.undo 间接调用，无 operationId 历史列表 |
| POST /ai/models | 直接UI；A041 从已保存接口拉取模型并搜索选择 | 无地址/密钥载荷、70秒客户端上限；服务端metadata GET、无推理/自动保存；旧后端404提示升级并保留手填 |
| POST /ai/organization-runs | 直接UI；A105 智能整理开始分析 | 源码接入/新增 DTO 与状态单测；支持 background: true 与 clientRequestId 异步启动与幂等重放；真实 Provider 与设备待验 |
| GET /ai/organization-runs/:id | 直接UI；A105 分析状态与进度读取 | 源码接入；读取阶段/批次/已处理数与服务端事件时间线，失败展示结构字段诊断；设备待验 |
| POST /ai/organization-runs/:id/resume | 直接UI；A105 超时后明确继续未完成批次 | 同runId、独立clientRequestId幂等重放；attempt/canResume，最多3次、24h有效、源快照变化409拒绝；会再次调用AI，可能收费 |
| GET /ai/organization-runs/:id/card | 直接UI；A105 审查卡片 | 源码接入/新增 DTO 单测；设备待验 |
| POST /ai/organization-runs/:id/apply | 直接UI；A105 单次确认应用 | 源码接入；幂等重试仅沿用相同 actionIds |
| POST /ai/organization-operations/:id/undo | 直接UI；A106 条件撤销 | 源码接入；冲突不部分恢复 |

服务端独立草稿返回 type/amountCents/categoryId/accountId/date/note/tags/confidence/reason/missing，只规范化，不写入账本；来源 live 分类和账户，不能猜未知 ID。独立月评有 summary 及 highlights/risks/suggestions 三个列表，每个列表最多 6 条，evidenceIds 每条 1–8 个有效且不重复证据，文本最多 500；当前自然月不是可选预算周期。旧 organization preview/apply 的可执行范围仍为 tag-merge/category-merge，transaction-reclassify/category-suggestion 只是建议；新的 organization-runs 工作区才是 Android 日期范围分类/标签整理入口，它走独立 run/card/apply/undo 合同。run 分析最多 500 笔，新任务10笔/批（旧任务保持其已冻结批大小）；超时仅经显式resume继续，已提交的成功批次不重算，不保证超时的上游请求没有收费；apply 只接受所选 actionIds（最多 100）并重验事件快照；undo 要求操作后状态未被后续修改。
<a id="forms"></a>
## 7. 表单字段与操作速查

这是输入端速查表，详细校验、动作和限制见相应 ID。客户端校验与服务器最终校验分别列出，不能把“输入框接受”视为“必能保存”。本文覆盖全部实际表单，不新增设计字段。

| 表单 / 入口 | 全部可编辑字段 / 默认与选项 | 本地校验、动作及提交边界 |
|---|---|---|
| 登录/注册 | 登录：用户名、密码；注册：另加确认密码、邀请码；均可切换密码可见 | 用户名/邀请码trim，密码保留原文；注册校验见P042；忙时禁重复；错误可恢复；无找回密码 |
| 服务器地址 | origin地址；恢复默认 | http(s)，无凭据、非根路径、query/fragment；保存才生效；换地址清会话；无连接测试 |
| 外观 | 浅色/深色/系统；钛蓝/森林绿/黑白；减少动态开关 | 即时本地应用与持久化尝试，系统关闭动画会进一步限制 |
| 预算周期 | 自然月null或1–28日 | 草稿改变才保存，约束来自服务器；周期日≠统计自然月 |
| 修改密码 | 当前密码、新密码、确认新密码 | 当前/新非空、确认一致；服务器新密码≥8字符；成功所有会话作废 |
| 账单搜索 | 关键词提交前 trim，支持全部历史/所选月份以及账户、类型组合；清空回月视图 | 匹配由配套服务端执行，搜索列表及月摘要需版本和一致快照标记；无客户端本地匹配；非空搜索服务端最多10000笔且交易行可变文本最多16 MiB UTF-8，客户端完整读取上限100000笔 |
| 账单新建/编辑 | 收支类型、金额、分类；账户/日期默认值；备注、标签、理财用途按需展开“更多”；收入退款及关联账单；收入类型可转入记工资 | 详见第4节；默认账户按认证服务器/用户名记忆并校验仍活跃，退款固定原账户；折叠只隐藏字段不清草稿；记工资复用工资域不POST普通交易；金额不是表达式计算器，正分与日期由服务端最终校验 |
| 工资新建/编辑 | 金额、到账日期、到账账户、备注；新建必选模板；分配编辑逐模块填写元金额（转换整数分） | 详见第4节；工资金额独立BigDecimal两位小数校验；原工资分配不要被金额编辑覆盖 |
| 分类 | 名称、新增时收入/支出类型、父分类、图标、颜色；编辑类型固定；上下排序是列表操作 | 父子类型与层级限制、排序/重命名/删除影响见第4节；不将Web字段猜成Android控件 |
| 账户 | 名称、账户类型、初始余额；上下排序是列表操作 | 完整字段和默认值见第4节；初始余额可为负，BigDecimal精确分校验 |
| 标签 | 原名称只读目标、新名称输入；删除确认 | 标签来自账单标签集合，非独立账户/分类；合并和影响范围见第4节 |
| 预算模板 | 模板名、模块、百分比；默认/应用操作 | 完整字段、总和容差、父子分类冲突见第4节；不是额度自定义输入 |
| 转账 | 转出账户、转入账户、方向交换、金额、日期、备注 | 必选两个不同账户，金额>0、日期有效；保存/取消；无脏草稿退出保护 |
| 本应用CSV导入 | 账单/转账类型、CSV文件 | 名称.csv、不空、手机≤10MiB、UTF8；确认直接上传，无dryRun；切类型清旧选择 |
| 平台账单导入 | 文件、逐行选择、逐行自由文本分类覆盖 | 手机≤5MiB，自动source；预览默认排除疑似重复等；确认所选；取消/关闭 |
| 立即备份 | 无文件路径/保留时长字段 | 后端创建数据库快照；不是导出到手机；只显示列表 |
| 物品创建/编辑 | 名称、分类、品牌、型号、备注、购入日期、可空购入价、支出关联、使用中/闲置 | 名称非空；价格空→null，非负；新物品分类空→其他；服务器字数/日期/关联限制见I007/I009 |
| 物品关联选择 | 账单单选、上一/下一页、清除、取消 | 每页50；买入支出、卖出收入；退款收入仍可能入选但最终会被拒；没有详情跳转 |
| 售出物品 | 结束日期、售出价、可选收入关联 | UI售出价必填非负，服务器可空；结束日期在购入日到今天之间；确认/取消 |
| 结束持有 | 结束日期 | 不早于购入不晚于今天；确认退役/取消 |
| 照片 / 抠图 | 系统图片文件、候选选择 | 无相机或裁剪表单；删除需确认；候选保存实际重新上传，失败保留原图 |
| 周期规则 | 名称、收入/支出、金额、分类、账户、五频率、锚点日期 | 默认支出/月/今天；名称1–60、金额>0；切类型清分类；日期选择器；不确定提交结果先核对 |
| 待确认 | 确认或忽略弹窗，字段只读 | 不能在确认时改金额/日期，不能批量确认；不可用引用禁确认，仍可忽略 |
| AI对话 | 文本、单个账单文件（单文件流程）或1–5个账单文件（融合批次流程）、移除附件、追问单选项（2–6项）、自由输入追问 | 纯文本经 POST /generations 流式发送（支持 POST /cancel 显式停止）；带附件走 legacy POST /messages 或多文件 POST /import-batches；服务端文字≤2000；发送与选项点击带 UUID clientRequestId 去重；选项点击不触发记账；断流通过 GET snapshot 核对 |
| AI导入卡 | 单文件导入卡：行选择、现有分类ID覆盖、独立备注编辑/清空、同原件分析重试、疑似重复就地对比；多文件融合批次卡与工作区：1–5个文件多选上传（单≤5MiB，总≤8MiB），全局≤500条待核对记录（100/页有界分页，validateAndReduceBatchPages 5页完整性校验），行选择/用户排除（暂不导入与重新选入即时反馈）/规则排除/冲突决策，现有活跃叶分类指派或新分类建议显式批准（无新分类自动批准，多同名叶分类弹窗选择，支持改名新建，未批准或未选中不创建），备注覆盖编辑/清空（服务端空字符串保留为(空备注)），只读对比现有账单（每页20项），失败文件就地替换/移除，两阶段review（权威财务总计、selectedRows逐行categoryType与拟新建徽章、ReviewSummary.counts独立分离ruleIgnored与可空userExcluded）与confirm原件多文件hash校验单事务原子入账 | 单文件200预览/100选择，hash+长度匹配；多文件融合批次500条上限超额整批拒绝，单5MiB总8MiB，Fastify批次路由12MiB上限；BigDecimal精确整数/长整型解析（2^63边界fail-close）；AI建议可逆，分析失败不伪称成功；无新分类自动批准，缺分类须显式批准/改名；非正金额/已入账/账本碰撞/弱冲突硬锁定，规则忽略原因行保持可选；对比不改草稿；原件多文件重传外部重验；严格非空viewRevision守卫，并发代次变动最多重试2次且保留草稿 |
| AI操作确认 | 只读摘要/影响数量/warnings及导入行选择 | 二次确认；取消；终态不可再执行；通用卡不展示所有嵌套数据 |
| AI Provider | enabled、mode、name、url、model、auth kind、secret、clearSecret、method、timeoutMs、headers、bodyTemplate、responsePath、headerName | 完整逐字段规则如下；保存/测试互斥，测试只针对已保存配置 |

### 7.1 Provider 逐字段规则

证据：[ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt)、[ai-config-service.ts](../../packages/server/src/services/ai-config-service.ts)。

| 字段 | 可用选项 / 规则 |
|---|---|
| enabled | 仅保存后修改服务器开关；关闭不调用模型，但助理附件走独立平台预览路径 |
| mode | chat-completions / responses / custom；切换保留当前编辑字段，不自动改请求路径/模板 |
| name | 配置名称，提交当前文本 |
| url | 完整请求URL；启用时服务器校验，生产HTTPS、无用户名密码 |
| model | 模型名；启用时不能空；无在线模型列表 |
| auth.kind | none / bearer / header；none不自动删除已有密钥 |
| secret | 遮罩输入；空表示保留，非空替换；未持久化在客户端 |
| clearSecret | 二次确认后只标记，保存才删除；可撤销，新密钥取消删除标记 |
| method | GET / POST / PUT / PATCH；启用非custom要求POST |
| timeoutMs | 默认20000；整数3000–60000 |
| headers | JSON对象；服务器最多20头、合法名称/字符串值、禁敏感认证头 |
| bodyTemplate | JSON模板，允许input/categories/accounts/model/today/responseSchema/facts；禁止secret/未知变量；custom非GET要求模板 |
| responsePath | 支持点路径/数组索引；custom要求填写；可按钮填Chat或Responses常用路径 |
| headerName | 只在header认证显示；不可空且服务器合法头名，禁止Cookie/Set-Cookie |
| hasSecret（只读） | 只知道有无密钥，不回显明文；其他encryptionKeyConfigured/updatedAt未显示 |

非custom模式的已保存bodyTemplate服务器返回null；未明确编辑时Android省略此字段以保留服务器值。认证保留bearer/header且启用时清密钥可能被服务器拒绝，不能把删除标记等同于成功清除。

<a id="accounting"></a>
## 8. 账务口径与数据边界

本节源码核对日期：**2026-10-17**（多文件融合批次新分类创建约束、BigDecimal 精确长整型解析与口径对齐）

- **账单**是收入/支出；金额为正整数分。退款是收入退款（isRefund），不是新建负数支出；退款关联关系是另一份合同，不能靠同金额推断。
- **账户余额**由服务器基于初始余额、有效账单、工资及有效转账计算；余额是全历史口径，账单列表通常只看所选自然月，二者不能直接相减核对。
- **支出/预算/结转/工资分配**使用服务器/shared逻辑；现有API字段名netExpenseCents仍保留，但可执行函数按毛支出统计，退款计收入，不冲减预算；页面只格式化、画比例或显示服务器结果，不在客户端重新实现财务合计。具体工资/退款归属与周期规则见第4节。
- **工资**有独立记录和分配快照，不等同于普通收入列表项。新建/编辑/删除可能影响余额与预算，依服务器返回和刷新为准。
- **转账**只改变两个账户间资金位置，排除于收入、支出和预算；删转账撤销余额影响，但没有转账回收站。
- **物品**是资产资料与持有成本台账，不新增账单、不改变账户余额和预算。购入/售出关联只能链接既有合法账单；不是会计折旧。
- **导入**：本应用CSV未知主数据拒绝；独立数据管理平台导入仍会创建/恢复指定账户/必要分类；单文件AI助理导入不创建/恢复分类，平台账户行为保留。多文件融合批次导入（1–5文件，全局≤500条）支持原子创建用户显式批准的新分类（无新分类自动批准；未批准或未被选中行引用的建议不创建，不恢复已删除分类，不创建新账户），平台账户与分类规则保留；两阶段审核 POST review 产生权威毛收支、退款收入与净额总计，前端不自算；逐行携带服务端 categoryType 与拟新建徽章，空备注 "" 明确展示为 (空备注)；统计卡片 counts 独立分离规则忽略（ruleIgnored）与用户主动排除（userExcluded，可空时展示为“未提供”，不回退为 0）；底层严格使用 BigDecimal 解析 64 位整数，阻断 2^63 边界浮点溢出。原退款购买保留支出，独立实际退款流水作为退款收入，状态不生成流水或关联。稳定订单ID去重与疑似重复是两种判断。CSV不保存整库/全部退款关联。
- **周期生成**只生成待确认快照，确认才写账本。没有自动入账/通知服务；最近12次到期以外历史不会反复刷新补齐。
- **日期**传输为毫秒时间戳，设备输入/展示使用本地时区；服务器部署时区可以不同。统计自然月、预算周期和账户全历史是三个维度。
- **存储**：服务器保存账本、对话、照片和备份；手机持久化服务地址、Cookie、外观偏好。未发送表单/AI附件字节一般仅内存，无离线业务数据库或写入队列。

### 8.1 金额输入不是统一解析器

证据：[TransactionEditSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt)、[SalarySheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalarySheet.kt)、[ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt)。

普通账单/转账/物品等使用的元转分解析接受数值文本（可能包含指数），校验有限、非负与安全范围后Math.round到分；可接受超过2位小数并四舍五入，**没有金额表达式计算器**。工资有单独BigDecimal/最多两位小数正数正则校验；账户初始余额只要求BigDecimal精确整数分与安全范围，可接受1.2300、1E2、+1，不能概括为与工资相同的严格两位数字格式。README不将旧设计中的“表达式金额”写成已实现功能。

<a id="gaps"></a>
## 9. 已知问题与显示缺口

以下是当前代码事实或源码风险，不是已经修好的功能。后续修复必须更新对应功能行与这里的状态，不只改文案。全部待设备复现/验收。

### 9.1 平台、导航和账单细节

| 问题 | 当前事实 | 对应证据/影响 |
|---|---|---|
| 首页详情→编辑 | ~~缺口~~ 已修复（2026-10-10）：详情记录来源页并路由到账单编辑分支；设备回放仍待验收 | P022 / MainShell |
| 外层返回绕过表单保护 | MyTab顶部按钮直接closeSection，除工资外可移除页面；周期规则内部BackHandler/取消确认不覆盖这个按钮 | MyTab / RecurringRulesTab；不要宣称所有退出路径都保护草稿 |
| 账单搜索/高级筛选 | 搜索入口已接入，但依赖支持 `searchVersion=1` 的服务端；分类/标签高级面板仍缺少打开入口。设备键盘、小屏与弱网交互待验 | L02.03/L02.04 / TransactionsTab |
| 详情分类/账户错误文案 | 元数据获取失败清空map，后续占位可能说“已删除”，即使是请求失败 | TransactionDetailScreen |
| 详情退款链接读失败 | 每个关联GET被runCatching吞掉，可能不完整显示关联，无独立读取失败提示 | TransactionDetailScreen |
| 关联选择器核对文案 | 文案提到详情核对，但行没有详情导航回调，只能选择/清除/取消 | LedgerLinkPicker |
| 日期输入宽度 | 禁宽松日期滚动并整段消费，未用正则强制yyyy-MM-dd各段固定宽度 | P034 / format |
| 外观保存异常 | 保存异常被吞，画面即时变化不保证下次启动仍保留 | P023 |
| reduced范围 | 自有MotionTokens为0，不代表所有Material内置动画统一关闭；十二原则无全量设备证据 | P026–P027 |
| HTTP地址与release | 校验接受HTTP，但release主Manifest不允许明文例外；Android9+连接可能失败 | P039 |

### 9.2 文件、物品、转账和周期


1. **CSV 限额冲突**：Android 本应用 CSV 可选 10 MiB，但 Fastify全局 `bodyLimit:8*1024*1024`（app.ts:60），无对应导入路由提升上限，8–10 MiB 文件可选但提交会413；本地检查与成功导入上限不可混写。平台5MiB Base64约6.67MiB加JSON，仍在8MiB附近但未实测。
2. **照片限额冲突**：手机允许读取5MiB原图，服务端照片≤2MiB；普通上传不压缩，因此2–5MiB选图可读但被拒。worker候选允许≤16MiB，而最终物品照片仍≤2MiB；大候选可能可预览但保存失败。不要承诺所有候选都可保存。
3. **回收站500行及全量操作**：客户端不显示total/无分页，bulk却影响全库；“恢复所有返回的账单/所列账单”与实际全库恢复不符，需要将此列为现有问题而不是功能说明中的保证。
4. **超期周期提示错误**：PendingTab.kt:105文案称再次刷新可继续处理；后端只留最近12周期、游标跳到今天后，旧周期不会再补齐。README应忠于服务端事实并记下待修正文案。
5. **物品详情字段未完整呈现**：支持输入≠支持在详情完整查看。售出价服务端可空而UI强制非负已填金额；概要数量未显示；终态详情没有独立修改售出价格/日期/关联界面，只能重开再闭合。
6. **关联选择器可出现退款收入候选**：物品售出按type=1列收入，并未预筛退款，最终服务端拒绝退款关联；不能把选择器全部候选视为有效售出关联。
7. **设备未验证**：SAF读取/写入、GBK/xlsx实际文件、超大文件、透明PNG、worker模型与超时、删除/恢复重算、UI金额语义、Android最低版本/HarmonyOS4均需独立设备与服务器证据。
8. **局部与全局认证处理分开**：多个 DataTab 确认导入/备份及照片/售出/转账删除操作只 catch Exception，未显式调用 onAuthExpired。但 ApiClient 拦截器对所有非登录 401 清理 Cookie 并设置 sessionExpired，MainActivity 收集该状态后返回登录；不能仅凭局部 catch 推断缺少全局导航。该全局路径属于源码接入，本轮没有设备响应时间或运行验证。
9. **规则编辑引用校验缺口**：createRule显式assertReferencesUsable；当前updateRule只检查字段形式，不同于创建时引用校验，已生成pending最终确认创建账单时会被交易服务校验。记录此为代码差异，不宣称编辑已具有完整服务端同类型引用校验。
10. **无新增功能假设**：没有任意Excel通用导入、数据库下载到手机、云盘备份、照片相机入口/批量照片、会计折旧、物品回收站、定时推送/自动确认、周期发生历史客户端、转账搜索/账户筛选/恢复。


**平台文件新选择失败的边界：** DataTab平台面板先读取新文件才清旧状态；取消选择或真正新选文件读取失败（例如超过5MiB）都可能保留旧预览。该行为不同于本应用CSV先清旧文件再读取。没有“无效新文件一定清旧预览”的保证。

### 9.3 AI 助理和 Provider

**2026-11-06 native completion gap on Android:** Android does not call native-completions or adopt its continuation generation. Existing import success refresh and generic confirmation are not this protocol. iOS/backend implementation and isolated tests are not Android UI/device evidence. No credential/logout/server-switch workflow resumes an invalidated auth scope.

**2026-11-06 工作区与通知差异：** Android 未协商 `workspace-v1`，不调用新 interaction/revise/continue/result-page/daily-review 路由，也不渲染 nativeAction 或新的执行轨迹视图。其现有 v1 流式输出、单项追问、通用草案确认及独立平台导入/历史整理继续使用原实现；新工具注册和 iOS 原生页面不补齐 Android 的复杂结果数组、草案字段编辑、确认后任务续接、聊天分页选择或跨页刷新缺口。20:00 记账/21:00 复盘是 iOS 本地通知默认值，需 OS 授权且可修改，复盘仅在点击后请求；Android 没有新增这些通知或自动模型任务。仅局部源码核对，不更新旧设备、Provider 或部署结论。

**2026-11-06新增工具与执行可靠性局部复核：** 新toolName不会被Android通用卡/二次确认封闭白名单阻止；values/preview可展开字段路径，但result仍只显示最多6个已知摘要字段、不遍历数组。因此新资金/目标/物品/统计读结果、spending.card/evidence分页与逐项选择不是完整的Android聊天工作区；既有A105–A106独立整理只支持分类/标签选择，不自动获得聊天工具的新分类应用能力，模板建议已退役。服务端现逐次保存读取结果并结束后台任务的模型轮询；Android聊天未新增后台任务观察卡，仍需独立整理入口查看完整进度与审查建议。确认普通业务工具后只刷新对话，现有`onDataChanged`成功信号限定导入分支，其他已打开业务页可能需要手动重读。Android的既有固定错误映射也未在本轮调整。这些是当前源码缺口；本轮仅更新目录，未改Android代码或宣称设备验收通过。


1. **导入日期错配已源码修复**：本轮统一读取服务端 `dateLabel`，新增decoder单元测试；实际文件/设备日期展示尚待验证。
2. **结果/确认卡只有有限摘要**：safeSummaryFields 只允许列出的字段名、最多 6 项、深度 2；不遍历数组内容。monthly evaluation、旧 organization actions/recommendations、balances/items 等复杂数据通常看不到完整细节。完整月评仍无专用页；日期范围整理已有 A105/A106 专用工作区，但旧 `organization.preview` 通用卡仍不是该工作区。无 evidence 钻取，无导出链接点击/下载（`links` 字段未在白名单）。可请求工具不等于可完整核对结果。
3. **组织操作预览**：本轮通用卡和二次核对可展开values及非导入preview全部嵌套字段/数组，含before/after；仍是通用文本路径而非专用整理/evidence页，阅读及大型结果性能需设备验证。服务端未投影的信息不推测。
4. **导入范围与恢复有界**：AI助理单文件展示/分析最多200行，确认显式1–100行，API超限拒绝；多文件融合批次导入支持1–5个文件，全局融合记录上限500条（超500条整批拒绝不截断），单文件≤5MiB且总大小≤8MiB（Fastify批次路由专属12MiB请求上限）；文件其余行不隐藏导入。新Data/Assistant平台入口统一走人工Host；未决批次重试复用原 clientRequestId、协议会话与同序原件bytes，未知分析状态只GET查询；Provider未ready、批次不在prepared/reviewed或原件hash不匹配时不触发AI。新Data会话创建结果未知且服务器没有按键查询能力时阻断重复会话创建，需人工核对。Data CSV、Data平台批次、Assistant平台/legacy导入仅在完整确定成功后调用现有摘要失效回调。SAFE picker取消、A/B对话所有权及弱网时序没有设备证据，均为 DEVICE PENDING；未连接真实Provider。
5. **禁用状态仍可发送**：助理状态文案显示关闭，但发送按钮本身不以 enabled 锁定。纯文字请求会由服务器返回 AI_NOT_CONFIGURED 安全消息；有附件仍保留确定性预览，但AI分析显示失败，不伪装完成；可以手动审核或显式重试。
6. **增量流式与核对机制**：纯文本 AI 对话通过 SSE /events 接收增量推流（单次流式连接，非轮询）；断流或异常 EOF 时不自动重发模型，而是通过 GET snapshot 单次核对最新状态；带附件请求仍保留 legacy 阻塞等待返回。
7. **secret 清除生效条件**：认证保持 bearer/header 且 enabled=true 又清除密钥时后端会拒绝保存（AiSecretUnavailable）；应关闭 AI、改无认证或替换密钥后保存。UI 清除标记不是立即清除。
8. **配置切模式只保当前内存字段**：服务端非 custom 返回 bodyTemplate null。UI 小心省略不可读字段，但无法显示其真实内容；仅当前会话保留已编辑模板，重开不能回显隐藏模板。
9. **智能整理旧账边界**：日期范围按服务端本地日历解释，Android 只发送 `YYYY-MM-DD` 并展示服务端返回范围；单次最多 500 笔，超过时服务端拒绝并提示缩小范围，不截断。分析请求采用 `background: true` 与唯一 UUID `clientRequestId` 异步发起，手机端每 ~1 秒读取一次服务端进度（最长观察 15 分钟），展示真实服务端阶段（准备/分析/校验/生成/就绪）、当前批次 X/Y、已处理笔数、已校验建议数（明确标注未应用）与服务端事件时间线，不展示伪造百分比或模型隐藏思考。分析失败展示固定结构字段诊断。若观察超时或网络中断，保留当前任务编号供手动“继续查看进度”通过 GET 恢复，绝不自动重新发起 POST；确定性 4xx 错误才清除请求允许重新选范围。2026-10-23起新任务每批10笔；Provider超时可在当前页明确继续安全断点（最多3次尝试、24h继续准入），源账单/分类等变化拒绝，旧版失败任务无断点不可继续；超时诊断只显示等待模型响应/阶段/批次，不伪称结构字段缺失。每次尝试10分钟执行预算，保留用户配置的单次Provider超时上限，不自动延长、不自动重复调用。成功批次不重新请求不等于上游恰好计费一次。分类/标签动作默认最多选 100 项；分类/标签/备注建议卡片可点击查看原账单只读详情，复用已有 GET /transactions/:id 及分类/账户元数据接口，不重新调用AI，不修改勾选；详情显示的是当前服务端原账单而非AI改写或历史快照，读取失败显示错误与重试，不猜测记录内容。备注建议、新分类建议、预算模板建议都不自动应用。应用成功后仅在当前页面保留最近一次 operationId 用于条件撤销，没有整理运行历史/审计历史列表，也没有跨页面恢复 operationId 的 UI。真实 Provider 多批延迟、弱网、进程回收和 500 笔边界仍需设备验收。
10. **验证边界与分级说明**：
   - **本地源码与模拟验证通过**：本轮多文件账单融合导入与边界修复闭环已有全套源码实施；后端 30 files / 684 unit & integration tests 全绿，shared 7 files / 187 tests 全绿，lint/typecheck/build 干净通过；Android 12 test suites / 156 JVM unit tests 全绿（Gradle XML 真实计数，基线 91 + 批次专项 65 项：NetworkContract 20 + State 45；初测 155 测 1 败因 platform_order -> 修复后 156 全绿），lintDebug 通过（0 errors / 9 warnings / 21 info，9 项为老基线文件中的 ModifierParameter/IconLauncherShape 等建议，无功能性错误，明确不宣称 0 warnings），assembleDebug 编译通过，debug APK 大小 18,473,623 字节，SHA-256 `ec2ab9e55f8f78db2b84a5fd5884d413011f7fd5b05733bbebb921ce700deba0` 独立核验（明确未在物理设备安装实测；前序构建 153 tests / 19,580,136 字节 `0c956aac...` 与 `09dc...` 完整保留为历史记录不可伪抹）。真实 5 份测试 fixture（manifest.json, batch.json, rows.json, categories.json, review.json）真实 SHA-256 哈希一致可查且不含私密数据。真实 Fastify wire JSON fixture 34 行初测 FAIL 修复后全量 34 行 PASS；null AI reason 使用 optCleanString 映射为 "" 避免字面 "null"；空备注 ""/新分类类型 0/1/拟新建名称/counts 各字段 nullable 行为全部保持。合成基准测试（`import-batch-bench.ts`）在本地模拟环境下验证 500 行解析（50ms / +11MiB heap）。
   - **未验证的物理/真实环境边界（Known Gaps，待后续验收）**：
     - 不能断言“真实线上协议已验证”（仅为本地源码与本地真实 Fastify wire 路由 mock/fixture 测试通过，生成 fixture 不等同于真实 Provider 或真机运行）；
     - 未在物理真实设备（华为 nova 7 Pro / HarmonyOS 4.2、小屏、实体键盘弹起等）安装或实测，最新 APK 明确未在设备安装过；
     - 未连接线上真实生产环境，未部署生产 Docker/Caddy 容器，未在 production.db 执行真实记账写入；
     - 未连接真实 upstream LLM Provider 执行真实多批次分片调用；
     - 合成基准测试（500行解析 50ms / +11MiB）与本地隔离数据库迁移排演仅为本地模拟环境数据校准，不能作为真实生产安全性或海量历史账单导出文件在弱网/低端手机内存受限环境下的安全性定论，真实海量导出基准跑分缺口保留，仍待后续专项验收；
     - 稳定功能条目更新为 316 项（原 314 + A105–A106）；本专项只新增这两个可见工作区条目，未重算全部历史域；
     - 源码实施反映当前工作区最新状态，但独立 review 仍处于最终读回中，不可过早视作全闭环完成（PARTIAL / NOT FULLY CLOSED / PENDING FINAL READBACK）；
     - 前端状态与 DTO 严格兼容旧版单文件 200/100 导入卡与取消流程；旧版 action 取消与归档逻辑保持不变。

### 9.4 账务审计保留的缺口ID


- **L-GAP01：首页详情编辑路由已源码修复（2026-10-30）**。详情记录来源页，编辑时切回来源并在独立全屏 Dialog 中打开 TransactionEditSheet；保存/取消后编辑器按来源刷新/返回。JVM/build 已验证源码，首页详情→编辑的实际设备路径仍待验。证据 [MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt)。
- **L-GAP02：退款原支出反向明细缺失**。只读详情未读取后端refundSummary/refundDetails；退款关联行不可点击跳转。选择器文案提“详情跳转”并未对应这份详情实现。
- **L-GAP03：父分类仍可在账单编辑器选择**。分类picker未过滤有孩子的父分类；后端assertCategoryUsable拒绝父类记账。不能写“所有可选分类都能保存”。[TransactionEditSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt) / [transaction-service.ts](../../packages/server/src/services/transaction-service.ts)。
- **M-GAP01：默认模板删除按钮与服务端不匹配**。按钮可点，后端返回验证错误；应在功能文档记录“默认模板不可删，先切默认”。
- **B-GAP01：预算页待处理卡不是处理入口**；普通成功预算页面没有显式刷新按钮，需切页/切周期等触发重新加载。工资流程onSaved为空，直到退出流程回预算重新组合才更新预算。
- **B-GAP02：近30天上界已源码修复（2026-10-30）**。统计页只用服务端window返回的同次now−720小时至now；无接口时明确不可用，不退回设备日历。JVM/API回归与设备/跨时区交互验收分别记录，设备待验。
- **S-GAP01：工资只列最近200笔，无分页；工资删除不进入交易回收站。** Android 旧工资创建现已带操作键并保留原请求供核对/重放；但当前服务端对未提交的旧创建请求返回 410，仅已提交相同用户/键/原载荷可重放。版本 1 基金工资创建和其编辑/删除合同尚未接入 Android（§4.8），不能把旧键重放等同于新建已兼容。设备及最终整合待验。
- **L-GAP09：四用途基金交易未接入 Android。** 表单仍仅支出两值旧 `financialPurpose`，不发送 `expectedFundPurposeRevision`；对已有显式 canonical 用途的旧字段变更，服务端拒绝为 409。服务端四值支持不等于客户端四用途录入/编辑可用；设备及最终整合待验。
- **L-GAP04：账单金额允许多余小数并四舍五入，与工资的最多两位小数正则、账户初始余额的精确整数分转换不同**；初始余额可接受指数或多余末尾零但拒绝非零厘精度。账单编辑/工资日期表单支持范围仍由服务端最终拒绝，DatePicker本身未限制2000..now+1天。
- **L-GAP05：详情关联读取的runCatching吞掉所有Exception**，其中可能包含AuthExpiredException与取消，局部无法区分失败原因。但 ApiClient 拦截器与 MainActivity 仍会处理任一非登录 HTTP401，不能据此断言关联阶段401缺少全局登录导航。这是局部静态错误边界，不是本轮改动。
- **L-GAP06：旧注释与现行函数冲突**。首页/图表用“净支出”文案，但退款已不冲减支出；shared/budget-engine开头、AccountFlow字段注释及旧frontend规范残留旧口径，功能README应明确实际运行函数。
- **L-GAP07：账单列表请求代次缺口已源码修复（2026-10-22）**。账户、月份、类型、刷新/重试及删除后重载统一使用不可变查询与请求代次（本轮移除页面翻页UI，改为完整月加载）；新查询立即隔离旧行/总数/每日统计，旧成功/错误/结束不能覆盖当前选择；相关生产辅助函数有 JVM 回归。仍未在设备弱网/快速切换下验收，普通同步 HTTP 协程取消不等于立即取消底层 socket。证据 [TransactionsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionsTab.kt)、[TransactionQueryHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionQueryHelper.kt)、[TransactionAccountFilterTest.kt](app/src/test/java/com/yansuu1/jizhang/ui/TransactionAccountFilterTest.kt)。
- **L-GAP08：年月只显示M月d日的交易详情/历史工资可能跨年不明确**；formatDay不含年，列表月份标题有年。该点属于展示事实，是否修改待UI方案。
<a id="absent"></a>
## 10. 没有接入或不存在的功能

**2026-11-06 backend-only capability boundary:** Native CSV/batch/photo/export result return and original-task continuation via native-completions are not implemented in Android. No Android functionality or notification acceptance is inferred from iOS/server source.

| 分类 | 明确范围 |
|---|---|
| 无应用入口 | 找回密码、共享账本、PIN/指纹锁、推送/Widget/后台自动记账、系统分享接收/URL深链、应用内更新/独立关于与帮助页、相机拍照；邀请码注册/多用户已接入P042–P045 |
| 无离线能力 | 没有Room账本缓存、HTTP响应缓存、断网写队列/同步；requireOnline仅旧注释，实际没有统一网络监控预先禁写 |
| 非手机备份 | 无整库下载/客户端数据库恢复/删除备份/云盘自动备份；CLI恢复属服务器运维 |
| 仅服务端过滤/详情 | 转账accountId过滤与单条GET；物品category精确过滤；周期occurrence历史；回收站不能完整分页 |
| 导入不支持 | 工资/周期规则CSV导入、任意Excel通用表格、退款关联CSV还原；平台source手动选择在UI未暴露 |
| 物品没有 | 会计折旧参数、多照片、批量照片、独立物品回收站、终态独立编辑售价/结束日期/出售关联；抠图不会识别物品资料 |
| AI无独立界面 | /ai/transaction-draft（无直接调用）、完整月评、整理运行历史/审计历史列表、工具目录catalog界面；智能整理旧账已有 A105/A106 专用工作区，但无历史运行列表、无跨页面撤销入口 |
| AI工具与原生UI边界 | 周期规则、转账修改/删除、canonical工资、物品及周期日已具服务端工具（A107–A116），通用确认可提交但不等于Android专用页面/完整结果展示；旧模板/预算分配工具已退役。密码/密钥/原文件仍不作为通用模型参数；工作区可返回受信任照片/抠图、凭据、导入导出等原生入口，Android 聊天未处理，不能宣称已获得 iOS 工作区。在线备份恢复/整库下载仍不存在。 |
| AI工作区与每日提醒 | 新分页选择、草案字段修改/替代、确认后续接、只读日复盘和原生入口协议为服务端/iOS 能力；Android 未协商或接入。Android 没有本轮每日记账/复盘本地通知，旧周期账单生成也不是通知服务。 |
| AI交互没有 | 纯文本流式文字与停止已源码接入（设备未验），附件仍无流式/取消；归档恢复/单条消息删除/旧消息编辑/重命名、通用PDF/照片/音频多模态分析 |
| 平台边界 | Android APK目标含鸿蒙4待实测；本文不等同HarmonyOS5/6原生端交付；仓库Web工程已退役，生产部署状态须单独验证 |

<a id="coverage"></a>
## 11. 源码和 API 覆盖

上面各域API表逐端点记录实际入口或仅服务端能力；主源码覆盖表用于防遗漏。不是把基础组件当成独立产品功能。


### 11.0 全部已注册服务端API（方法＋路径）

**局部登记说明（2026-11-06）：** 下文 126/127/132/137 是保留的历史登记数字，不能当作新增身份/工作区等端点后的当前总数。本次只追加已复核的工作区/轨迹路由及抠图输入兼容说明，不重算全库数量或推进其他端点审计日期。新增行的“仅后端/iOS”表示 Android 未消费，不能等同 Android 功能覆盖。

前序全量登记126项；既有 transactions route 增加1项每日汇总后为127项；新增 5 项 AI 智能整理运行端点后为132项；2026-10-23新增1项resume、2026-10-26新增模型列表及3个独立理财计划端点后为 **137项**（14个route文件136项，app.ts健康接口1项；未全量复审无关接口）。除登录/健康等明确豁免路径，其余业务接口受会话认证保护，“API接口”不表示无认证公开访问。下表逐项登记，实际payload/字段/状态见各功能域API表；所有“直接UI/间接工具”均设备未验。

| 方法 | 完整路径 | Android接入状态 / 功能域 | 路由源码 |
|---|---|---|---|
| GET | `/api/v1/transactions/daily-summary` | 直接UI；L02月份筛选收支，搜索时需 `searchVersion=1`，全部历史不调用；需配套服务端部署 | [transactions.ts](../../packages/server/src/routes/transactions.ts) |
| GET | `/api/v1/ai/config` | 直接UI；AI设置/独立AI | [ai.ts](../../packages/server/src/routes/ai.ts) |
| PUT | `/api/v1/ai/config` | 直接UI；AI设置/独立AI | [ai.ts](../../packages/server/src/routes/ai.ts) |
| POST | `/api/v1/ai/test` | 直接UI；AI设置/独立AI | [ai.ts](../../packages/server/src/routes/ai.ts) |
| POST | `/api/v1/ai/transaction-draft` | 仅服务端，无Android入口；AI设置/独立AI | [ai.ts](../../packages/server/src/routes/ai.ts) |
| POST | `/api/v1/ai/monthly-evaluation` | 间接工具，无完整独立UI；AI设置/独立AI | [ai.ts](../../packages/server/src/routes/ai.ts) |
| POST | `/api/v1/ai/organization-preview` | 间接工具，无完整独立UI；AI设置/独立AI | [ai.ts](../../packages/server/src/routes/ai.ts) |
| POST | `/api/v1/ai/organization-apply` | 间接工具，无完整独立UI；AI设置/独立AI | [ai.ts](../../packages/server/src/routes/ai.ts) |
| POST | `/api/v1/ai/organization-undo` | 间接工具，无完整独立UI；AI设置/独立AI | [ai.ts](../../packages/server/src/routes/ai.ts) |
| POST | `/api/v1/ai/models` | 直接UI；A041已保存连接模型列表（无自动推理/保存） | [ai.ts](../../packages/server/src/routes/ai.ts) |
| POST | `/api/v1/ai/organization-runs` | 直接UI；A105 智能整理旧账开始分析（支持 background/clientRequestId） | [ai.ts](../../packages/server/src/routes/ai.ts) |
| GET | `/api/v1/ai/organization-runs/:id` | 直接UI；A105 分析状态与进度事件读取 | [ai.ts](../../packages/server/src/routes/ai.ts) |
| POST | `/api/v1/ai/organization-runs/:id/resume` | 直接UI；A105 超时后显式继续安全断点 | [ai.ts](../../packages/server/src/routes/ai.ts) |
| GET | `/api/v1/ai/organization-runs/:id/card` | 直接UI；A105 审查卡片 | [ai.ts](../../packages/server/src/routes/ai.ts) |
| POST | `/api/v1/ai/organization-runs/:id/apply` | 直接UI；A105 单次确认应用 | [ai.ts](../../packages/server/src/routes/ai.ts) |
| POST | `/api/v1/ai/organization-operations/:id/undo` | 直接UI；A106 条件撤销 | [ai.ts](../../packages/server/src/routes/ai.ts) |
| GET | `/api/v1/assistant/tools` | 仅服务端，无Android入口；助理 | [assistant.ts](../../packages/server/src/routes/assistant.ts) |
| GET | `/api/v1/assistant/workspace/capabilities` | 仅后端/iOS；Android 未消费，工具及受信任原生入口目录 | [assistant-workspace.ts](../../packages/server/src/routes/assistant-workspace.ts) |
| POST | `/api/v1/assistant/data-import/preview` | 仅后端/iOS；Android Data CSV 入口沿用原路由 | [assistant-workspace.ts](../../packages/server/src/routes/assistant-workspace.ts) |
| POST | `/api/v1/assistant/data-import/:id/confirm` | 仅后端/iOS；原文件/预览匹配后的确认 | [assistant-workspace.ts](../../packages/server/src/routes/assistant-workspace.ts) |
| GET | `/api/v1/assistant/conversations/:cid/workspace` | 仅后端/iOS；持久任务状态 | [assistant-workspace.ts](../../packages/server/src/routes/assistant-workspace.ts) |
| GET | `/api/v1/assistant/conversations/:cid/workspace/interactions/:iid` | 仅后端/iOS；分页资源选择 | [assistant-workspace.ts](../../packages/server/src/routes/assistant-workspace.ts) |
| POST | `/api/v1/assistant/conversations/:cid/workspace/interactions/:iid/answer` | 仅后端/iOS；验证选择并续接 | [assistant-workspace.ts](../../packages/server/src/routes/assistant-workspace.ts) |
| GET | `/api/v1/assistant/conversations/:cid/workspace/actions/:aid` | 仅后端/iOS；读取可修改草案 | [assistant-workspace.ts](../../packages/server/src/routes/assistant-workspace.ts) |
| POST | `/api/v1/assistant/conversations/:cid/workspace/actions/:aid/revise` | 仅后端/iOS；关闭旧草案并创建新待确认预览 | [assistant-workspace.ts](../../packages/server/src/routes/assistant-workspace.ts) |
| POST | `/api/v1/assistant/conversations/:cid/workspace/actions/:aid/continue` | 仅后端/iOS；确认后原任务续接 | [assistant-workspace.ts](../../packages/server/src/routes/assistant-workspace.ts) |
| POST | `/api/v1/assistant/conversations/:cid/workspace/results/:mid/page` | 仅后端/iOS；原查询结果分页 | [assistant-workspace.ts](../../packages/server/src/routes/assistant-workspace.ts) |
| POST | `/api/v1/assistant/conversations/:cid/workspace/organization/card` | 仅后端/iOS；读取已有整理卡 | [assistant-workspace.ts](../../packages/server/src/routes/assistant-workspace.ts) |
| POST | `/api/v1/assistant/conversations/:cid/workspace/organization/prepare` | 仅后端/iOS；准备所选建议预览 | [assistant-workspace.ts](../../packages/server/src/routes/assistant-workspace.ts) |
| POST | `/api/v1/assistant/conversations/:cid/workspace/native-completions` | Backend/iOS only; frozen source/request + typed receipt -> verified original-task continuation; no Android consumer | [assistant-workspace.ts](../../packages/server/src/routes/assistant-workspace.ts) |
| POST | `/api/v1/assistant/conversations/:cid/workspace/daily-review` | 仅后端/iOS；明确日期的只读复盘 | [assistant-workspace.ts](../../packages/server/src/routes/assistant-workspace.ts) |
| GET | `/api/v1/assistant/conversations/:conversationId/generations/:generationId/trace` | 仅后端/iOS；安全步骤元信息，Android 未接轨迹视图 | [assistant.ts](../../packages/server/src/routes/assistant.ts) |
| GET | `/api/v1/assistant/conversations` | 直接UI；助理 | [assistant.ts](../../packages/server/src/routes/assistant.ts) |
| POST | `/api/v1/assistant/conversations` | 直接UI；助理 | [assistant.ts](../../packages/server/src/routes/assistant.ts) |
| GET | `/api/v1/assistant/conversations/:id/messages` | 直接UI；助理 | [assistant.ts](../../packages/server/src/routes/assistant.ts) |
| POST | `/api/v1/assistant/conversations/:id/messages` | 直接UI；助理 | [assistant.ts](../../packages/server/src/routes/assistant.ts) |
| POST | `/api/v1/assistant/conversations/:conversationId/generations` | 直接UI；助理流式代次创建/重放 | [assistant.ts](../../packages/server/src/routes/assistant.ts) |
| GET | `/api/v1/assistant/conversations/:conversationId/generations` | 直接UI；助理最近代次快照读取 | [assistant.ts](../../packages/server/src/routes/assistant.ts) |
| GET | `/api/v1/assistant/conversations/:conversationId/generations/:generationId` | 直接UI；助理指定代次快照读取 | [assistant.ts](../../packages/server/src/routes/assistant.ts) |
| POST | `/api/v1/assistant/conversations/:conversationId/generations/:generationId/cancel` | 直接UI；助理显式停止生成 | [assistant.ts](../../packages/server/src/routes/assistant.ts) |
| GET | `/api/v1/assistant/conversations/:conversationId/generations/:generationId/events` | 直接UI；助理SSE流式事件增量读取 | [assistant.ts](../../packages/server/src/routes/assistant.ts) |
| GET | `/api/v1/assistant/conversations/:conversationId/actions/:id/rows/:rowId/duplicates` | 直接UI；助理导入疑似重复行对比 | [assistant.ts](../../packages/server/src/routes/assistant.ts) |
| POST | `/api/v1/assistant/actions/:id/analyse` | 直接UI；原件匹配后显式重试AI分析 | [assistant.ts](../../packages/server/src/routes/assistant.ts) |
| POST | `/api/v1/assistant/actions/:id/confirm` | 直接UI；助理 | [assistant.ts](../../packages/server/src/routes/assistant.ts) |
| POST | `/api/v1/assistant/actions/:id/cancel` | 直接UI；助理 | [assistant.ts](../../packages/server/src/routes/assistant.ts) |
| DELETE | `/api/v1/assistant/conversations/:id` | 直接UI；助理 | [assistant.ts](../../packages/server/src/routes/assistant.ts) |
| POST | `/api/v1/assistant/conversations/:conversationId/import-batches` | 直接UI；创建/重放多文件融合导入批次 | [import-batches.ts](../../packages/server/src/routes/import-batches.ts) |
| GET | `/api/v1/assistant/conversations/:conversationId/import-batches/:batchId` | 直接UI；获取批次主状态与统计 | [import-batches.ts](../../packages/server/src/routes/import-batches.ts) |
| GET | `/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/rows` | 直接UI；分页获取融合账单行 | [import-batches.ts](../../packages/server/src/routes/import-batches.ts) |
| GET | `/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/rows/:itemId/duplicates` | 直接UI；融合账单行现有疑似重复对比 | [import-batches.ts](../../packages/server/src/routes/import-batches.ts) |
| GET | `/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/categories` | 直接UI；获取活跃叶分类与新分类建议 | [import-batches.ts](../../packages/server/src/routes/import-batches.ts) |
| POST | `/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/review` | 直接UI；提交审核载荷获取权威摘要与令牌 | [import-batches.ts](../../packages/server/src/routes/import-batches.ts) |
| POST | `/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/analyse` | 直接UI；异步发起/重试AI分类建议分析 | [import-batches.ts](../../packages/server/src/routes/import-batches.ts) |
| POST | `/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/files/:fileIndex/remove` | 直接UI；移除指定失败文件并重新融合 | [import-batches.ts](../../packages/server/src/routes/import-batches.ts) |
| POST | `/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/files/:fileIndex/replace` | 直接UI；替换指定失败文件并重新融合 | [import-batches.ts](../../packages/server/src/routes/import-batches.ts) |
| POST | `/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/confirm` | 直接UI；原件重传校验并原子执行记账与新分类创建 | [import-batches.ts](../../packages/server/src/routes/import-batches.ts) |
| POST | `/api/v1/assistant/conversations/:conversationId/import-batches/:batchId/cancel` | 直接UI；显式取消融合导入批次 | [import-batches.ts](../../packages/server/src/routes/import-batches.ts) |
| GET | `/api/v1/auth/me` | 直接UI；认证 | [auth.ts](../../packages/server/src/routes/auth.ts) |
| POST | `/api/v1/auth/login` | 直接UI；认证 | [auth.ts](../../packages/server/src/routes/auth.ts) |
| POST | `/api/v1/auth/register` | 直接UI；邀请码注册P042 | [RegistrationScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/RegistrationScreen.kt) |
| GET/POST | `/api/v1/admin/invitations` | 直接UI；管理员邀请P043 | [InvitationRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/InvitationRepository.kt) |
| DELETE | `/api/v1/admin/invitations/:id` | 直接UI；管理员撤销P043 | [InvitationManagementScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/InvitationManagementScreen.kt) |
| POST | `/api/v1/auth/logout` | 直接UI；认证 | [auth.ts](../../packages/server/src/routes/auth.ts) |
| POST | `/api/v1/auth/password` | 直接UI；认证 | [auth.ts](../../packages/server/src/routes/auth.ts) |
| GET | `/api/v1/financial-planning/periods` | 直接UI；B03.09历史确认周期，每页10条，limit/offset分页，只读 | [financial-planning.ts](../../packages/server/src/routes/financial-planning.ts) |
| GET | `/api/v1/financial-planning/periods/:periodId/revisions` | 直接UI；B03.09周期修订分页与冻结详情，只读；来源核对状态为当前事实 | [financial-planning.ts](../../packages/server/src/routes/financial-planning.ts) |
| GET | `/api/v1/monthly-plan` | 直接UI；B03.12默认只读月计划（periodId/month可选且互斥）；no-period/disabled和待核对状态均不补零 | [financial-planning.ts](../../packages/server/src/routes/financial-planning.ts)、[monthly-plan-service.ts](../../packages/server/src/services/monthly-plan-service.ts) |
| GET | `/api/v1/financial-goals` | 直接UI；B03.13手动存钱与投资实际进度视图 | [financial-goals.ts](../../packages/server/src/routes/financial-goals.ts) |
| PUT | `/api/v1/financial-goals/opening` | 直接UI；B03.13确认/更正起始值与整段非负重放 | [financial-goals.ts](../../packages/server/src/routes/financial-goals.ts) |
| GET | `/api/v1/financial-goals/entries` | 直接UI；B03.13手动存取与投入明细游标分页 | [financial-goals.ts](../../packages/server/src/routes/financial-goals.ts) |
| POST | `/api/v1/financial-goals/entries` | 直接UI；B03.13记录存入/取出/投入/取回 | [financial-goals.ts](../../packages/server/src/routes/financial-goals.ts) |
| PATCH | `/api/v1/financial-goals/entries/:id` | 直接UI；B03.13修改手动记录 | [financial-goals.ts](../../packages/server/src/routes/financial-goals.ts) |
| DELETE | `/api/v1/financial-goals/entries/:id` | 直接UI；B03.13软删除手动记录 | [financial-goals.ts](../../packages/server/src/routes/financial-goals.ts) |
| GET | `/api/v1/financial-goals/operations/:operationId` | 直接UI；B03.13未知操作结果状态核验 | [financial-goals.ts](../../packages/server/src/routes/financial-goals.ts) |
| GET | `/api/v1/financial-plan` | 直接UI；B03当前独立理财计划 | [budget.ts](../../packages/server/src/routes/budget.ts) |
| POST | `/api/v1/financial-plan/preview` | 直接UI；B03显式只读试算 | [budget.ts](../../packages/server/src/routes/budget.ts) |
| PUT | `/api/v1/financial-plan` | 直接UI；B03 revision校验保存独立输入 | [budget.ts](../../packages/server/src/routes/budget.ts) |
| GET | `/api/v1/budget/overview` | 直接UI；工资/预算/模板/周期设置 | [budget.ts](../../packages/server/src/routes/budget.ts) |
| GET | `/api/v1/budget/periods` | 直接UI；工资/预算/模板/周期设置 | [budget.ts](../../packages/server/src/routes/budget.ts) |
| GET | `/api/v1/salaries` | 直接UI；工资/预算/模板/周期设置 | [budget.ts](../../packages/server/src/routes/budget.ts) |
| GET | `/api/v1/salaries/:id` | 直接UI；工资/预算/模板/周期设置 | [budget.ts](../../packages/server/src/routes/budget.ts) |
| POST | `/api/v1/salaries` | Android 有旧请求入口；当前服务端未提交的旧创建请求返回 410，已提交旧请求可按原键/载荷重放；版本 1 基金工资未接入 Android（§4.8） | [budget.ts](../../packages/server/src/routes/budget.ts) |
| PATCH | `/api/v1/salaries/:id` | Android 旧编辑入口；基金工资版本 1/grant revision/操作键合同未接入（§4.8） | [budget.ts](../../packages/server/src/routes/budget.ts) |
| PUT | `/api/v1/salaries/:id/allocations` | Android 旧模块分配入口；并非基金 grant 编辑 | [budget.ts](../../packages/server/src/routes/budget.ts) |
| DELETE | `/api/v1/salaries/:id` | Android 旧无体删除入口；基金工资版本 1/grant revision/操作键合同未接入（§4.8） | [budget.ts](../../packages/server/src/routes/budget.ts) |
| GET | `/api/v1/templates` | 直接UI；工资/预算/模板/周期设置 | [budget.ts](../../packages/server/src/routes/budget.ts) |
| POST | `/api/v1/templates` | 直接UI；工资/预算/模板/周期设置 | [budget.ts](../../packages/server/src/routes/budget.ts) |
| PATCH | `/api/v1/templates/:id` | 直接UI；工资/预算/模板/周期设置 | [budget.ts](../../packages/server/src/routes/budget.ts) |
| DELETE | `/api/v1/templates/:id` | 直接UI；工资/预算/模板/周期设置 | [budget.ts](../../packages/server/src/routes/budget.ts) |
| POST | `/api/v1/templates/:id/default` | 直接UI；工资/预算/模板/周期设置 | [budget.ts](../../packages/server/src/routes/budget.ts) |
| POST | `/api/v1/templates/:id/apply-current` | 直接UI；工资/预算/模板/周期设置 | [budget.ts](../../packages/server/src/routes/budget.ts) |
| GET | `/api/v1/settings` | 直接UI；工资/预算/模板/周期设置 | [budget.ts](../../packages/server/src/routes/budget.ts) |
| PUT | `/api/v1/settings` | 直接UI；工资/预算/模板/周期设置 | [budget.ts](../../packages/server/src/routes/budget.ts) |
| POST | `/api/v1/items/cutouts` | 直接UI；Android 仍上传 WebP；服务端新增 JPEG/PNG 输入供 iOS 兼容，输出格式与归属/大小校验不变 | [item-cutouts.ts](../../packages/server/src/routes/item-cutouts.ts) |
| GET | `/api/v1/items/cutouts/:jobId` | 直接UI；抠图 | [item-cutouts.ts](../../packages/server/src/routes/item-cutouts.ts) |
| DELETE | `/api/v1/items/cutouts/:jobId` | 直接UI；抠图 | [item-cutouts.ts](../../packages/server/src/routes/item-cutouts.ts) |
| GET | `/api/v1/items/cutouts/:jobId/candidates/:candidateId/preview` | 直接UI；抠图 | [item-cutouts.ts](../../packages/server/src/routes/item-cutouts.ts) |
| GET | `/api/v1/items/cutouts/:jobId/candidates/:candidateId/image` | 直接UI；抠图 | [item-cutouts.ts](../../packages/server/src/routes/item-cutouts.ts) |
| GET | `/api/v1/items` | 直接UI；物品/照片 | [items.ts](../../packages/server/src/routes/items.ts) |
| GET | `/api/v1/items/summary` | 直接UI；物品/照片 | [items.ts](../../packages/server/src/routes/items.ts) |
| GET | `/api/v1/items/:id` | 直接UI；物品/照片 | [items.ts](../../packages/server/src/routes/items.ts) |
| POST | `/api/v1/items` | 直接UI；物品/照片 | [items.ts](../../packages/server/src/routes/items.ts) |
| PATCH | `/api/v1/items/:id` | 直接UI；物品/照片 | [items.ts](../../packages/server/src/routes/items.ts) |
| DELETE | `/api/v1/items/:id` | 直接UI；物品/照片 | [items.ts](../../packages/server/src/routes/items.ts) |
| POST | `/api/v1/items/:id/sell` | 直接UI；物品/照片 | [items.ts](../../packages/server/src/routes/items.ts) |
| POST | `/api/v1/items/:id/retire` | 直接UI；物品/照片 | [items.ts](../../packages/server/src/routes/items.ts) |
| PUT | `/api/v1/items/:id/photo` | 直接UI；物品/照片 | [items.ts](../../packages/server/src/routes/items.ts) |
| GET | `/api/v1/items/:id/photo` | 直接UI；物品/照片 | [items.ts](../../packages/server/src/routes/items.ts) |
| DELETE | `/api/v1/items/:id/photo` | 直接UI；物品/照片 | [items.ts](../../packages/server/src/routes/items.ts) |
| GET | `/api/v1/categories` | 直接UI；主数据 | [master-data.ts](../../packages/server/src/routes/master-data.ts) |
| POST | `/api/v1/categories` | 直接UI；主数据 | [master-data.ts](../../packages/server/src/routes/master-data.ts) |
| PATCH | `/api/v1/categories/:id` | 直接UI；主数据 | [master-data.ts](../../packages/server/src/routes/master-data.ts) |
| DELETE | `/api/v1/categories/:id` | 直接UI；主数据 | [master-data.ts](../../packages/server/src/routes/master-data.ts) |
| POST | `/api/v1/categories/:id/move` | 直接UI；主数据 | [master-data.ts](../../packages/server/src/routes/master-data.ts) |
| GET | `/api/v1/accounts` | 直接UI；主数据；账单账户选择使用 `includeDeleted=true` 保留历史账户名称，DTO不提供删除标记 | [master-data.ts](../../packages/server/src/routes/master-data.ts) |
| GET | `/api/v1/accounts/balances` | 直接UI；主数据 | [master-data.ts](../../packages/server/src/routes/master-data.ts) |
| POST | `/api/v1/accounts` | 直接UI；主数据 | [master-data.ts](../../packages/server/src/routes/master-data.ts) |
| PATCH | `/api/v1/accounts/:id` | 直接UI；主数据 | [master-data.ts](../../packages/server/src/routes/master-data.ts) |
| DELETE | `/api/v1/accounts/:id` | 直接UI；主数据 | [master-data.ts](../../packages/server/src/routes/master-data.ts) |
| POST | `/api/v1/accounts/:id/move` | 直接UI；主数据 | [master-data.ts](../../packages/server/src/routes/master-data.ts) |
| GET | `/api/v1/tags` | 直接UI；主数据、账单筛选元数据、记账已有标签搜索多选（L04.06） | [master-data.ts](../../packages/server/src/routes/master-data.ts) |
| PATCH | `/api/v1/tags` | 直接UI；主数据 | [master-data.ts](../../packages/server/src/routes/master-data.ts) |
| DELETE | `/api/v1/tags/:id` | 直接UI；主数据 | [master-data.ts](../../packages/server/src/routes/master-data.ts) |
| GET | `/api/v1/categories/:id/usage` | 直接UI；主数据 | [master-data.ts](../../packages/server/src/routes/master-data.ts) |
| GET | `/api/v1/accounts/:id/usage` | 直接UI；主数据 | [master-data.ts](../../packages/server/src/routes/master-data.ts) |
| GET | `/api/v1/export/transactions.csv` | 直接UI；文件/备份 | [portability.ts](../../packages/server/src/routes/portability.ts) |
| GET | `/api/v1/export/salaries.csv` | 直接UI；文件/备份 | [portability.ts](../../packages/server/src/routes/portability.ts) |
| GET | `/api/v1/export/recurring.csv` | 直接UI；文件/备份 | [portability.ts](../../packages/server/src/routes/portability.ts) |
| GET | `/api/v1/export/transfers.csv` | 直接UI；文件/备份 | [portability.ts](../../packages/server/src/routes/portability.ts) |
| POST | `/api/v1/import/transactions` | 直接UI；文件/备份 | [portability.ts](../../packages/server/src/routes/portability.ts) |
| POST | `/api/v1/import/transfers` | 直接UI；文件/备份 | [portability.ts](../../packages/server/src/routes/portability.ts) |
| POST | `/api/v1/import/platform-bills` | 直接UI；文件/备份 | [portability.ts](../../packages/server/src/routes/portability.ts) |
| GET | `/api/v1/backups` | 直接UI；文件/备份 | [portability.ts](../../packages/server/src/routes/portability.ts) |
| POST | `/api/v1/backups` | 直接UI；文件/备份 | [portability.ts](../../packages/server/src/routes/portability.ts) |
| GET | `/api/v1/recurring/rules` | 直接UI；周期规则/待确认 | [recurring.ts](../../packages/server/src/routes/recurring.ts) |
| POST | `/api/v1/recurring/rules` | 直接UI；周期规则/待确认 | [recurring.ts](../../packages/server/src/routes/recurring.ts) |
| PATCH | `/api/v1/recurring/rules/:id` | 直接UI；周期规则/待确认 | [recurring.ts](../../packages/server/src/routes/recurring.ts) |
| DELETE | `/api/v1/recurring/rules/:id` | 直接UI；周期规则/待确认 | [recurring.ts](../../packages/server/src/routes/recurring.ts) |
| POST | `/api/v1/recurring/rules/:id/enabled` | 直接UI；周期规则/待确认 | [recurring.ts](../../packages/server/src/routes/recurring.ts) |
| POST | `/api/v1/recurring/generate` | 直接UI；周期规则/待确认 | [recurring.ts](../../packages/server/src/routes/recurring.ts) |
| GET | `/api/v1/recurring/occurrences` | 仅服务端，无Android入口；周期规则/待确认 | [recurring.ts](../../packages/server/src/routes/recurring.ts) |
| GET | `/api/v1/recurring/pending` | 直接UI；周期规则/待确认 | [recurring.ts](../../packages/server/src/routes/recurring.ts) |
| POST | `/api/v1/recurring/occurrences/:id/confirm` | 直接UI；周期规则/待确认 | [recurring.ts](../../packages/server/src/routes/recurring.ts) |
| POST | `/api/v1/recurring/occurrences/:id/ignore` | 直接UI；周期规则/待确认 | [recurring.ts](../../packages/server/src/routes/recurring.ts) |
| GET | `/api/v1/stats/window` | 直接UI；服务端本月/指定月/滚动30天，真实半开区间与IANA时区 | [stats.ts](../../packages/server/src/routes/stats.ts) |
| GET | `/api/v1/stats/category-share` | 直接UI；毛支出/退款收入子项，精确账户/分类条件和expenseCount用于完整明细核对 | [stats.ts](../../packages/server/src/routes/stats.ts) |
| GET | `/api/v1/stats/monthly-trend` | 直接UI；统计 | [stats.ts](../../packages/server/src/routes/stats.ts) |
| GET | `/api/v1/stats/pool-trend` | 直接UI；分类信封高级预算，已移出统计主页 | [stats.ts](../../packages/server/src/routes/stats.ts) |
| GET | `/api/v1/stats/range` | 兼容API；统计页已不调用 | [stats.ts](../../packages/server/src/routes/stats.ts) |
| GET | `/api/v1/stats/month-window` | 兼容API；统计页已改用stats/window | [stats.ts](../../packages/server/src/routes/stats.ts) |
| GET | `/api/v1/transactions` | 直接UI；账单可组合账户/类型及 `search`，全历史搜索省略时间范围，逐页要求 `searchVersion=1`；工资/转账不混入 | [transactions.ts](../../packages/server/src/routes/transactions.ts) |
| GET | `/api/v1/transactions/:id` | 直接UI；账单及A105整理建议卡片的原账单只读详情（复用L03） | [transactions.ts](../../packages/server/src/routes/transactions.ts) |
| POST | `/api/v1/transactions` | 直接UI；旧两值用途，四用途 `fundPurpose` 仅服务端 | [transactions.ts](../../packages/server/src/routes/transactions.ts) |
| PATCH | `/api/v1/transactions/:id` | 直接UI；旧用途写入无基金 revision，对显式 canonical 用途会遭 409；四用途编辑未接入 | [transactions.ts](../../packages/server/src/routes/transactions.ts) |
| DELETE | `/api/v1/transactions/:id` | 直接UI；账单 | [transactions.ts](../../packages/server/src/routes/transactions.ts) |
| GET | `/api/v1/transfers` | 直接UI；转账 | [transfers.ts](../../packages/server/src/routes/transfers.ts) |
| POST | `/api/v1/transfers` | 直接UI；转账 | [transfers.ts](../../packages/server/src/routes/transfers.ts) |
| GET | `/api/v1/transfers/:id` | 仅服务端，无Android入口；转账 | [transfers.ts](../../packages/server/src/routes/transfers.ts) |
| PATCH | `/api/v1/transfers/:id` | 直接UI；转账 | [transfers.ts](../../packages/server/src/routes/transfers.ts) |
| DELETE | `/api/v1/transfers/:id` | 直接UI；转账 | [transfers.ts](../../packages/server/src/routes/transfers.ts) |
| GET | `/api/v1/trash` | 直接UI；账单回收站 | [trash.ts](../../packages/server/src/routes/trash.ts) |
| POST | `/api/v1/trash/restore-all` | 直接UI；账单回收站 | [trash.ts](../../packages/server/src/routes/trash.ts) |
| POST | `/api/v1/trash/:id/restore` | 直接UI；账单回收站 | [trash.ts](../../packages/server/src/routes/trash.ts) |
| DELETE | `/api/v1/trash/:id` | 直接UI；账单回收站 | [trash.ts](../../packages/server/src/routes/trash.ts) |
| DELETE | `/api/v1/trash` | 直接UI；账单回收站 | [trash.ts](../../packages/server/src/routes/trash.ts) |
| GET | `/api/v1/health` | 仅服务端，无Android入口；平台健康 | [app.ts](../../packages/server/src/app.ts) |

### 11.1 全部 main Kotlin 文件

> **范围说明**：本表提供工程内全部 113 个 main Kotlin 源码路径（2026-10-31按实际路径重新核对目录；本轮补录 T09 新增 PlatformImportState.kt、T10 新增 AssistantBatchRecoveryState.kt、AssistantBatchRecoveryStore.kt 与 T12 新增 NavigationLeaveGuard.kt）的目录与条目收录覆盖（catalogue / inventory listing coverage；2026-10-22 新增图标控制器、真实余额解码、详情录入辅助、完整月份加载器及 AI 智能整理仓库/模型/状态/工作区 4 个文件；2026-10-30 新增 ApiRequestIdentity、ApiRequestOwner、ApiTransport、SalaryTemplateState 与 ManualGoalEntryListState）。前序多文件融合导入仅重点核对其相关网络传输、批次 DTO、状态机与工作区组件；T09仅重点核对新统一入口/所有权/确认回调及对应定向用例；T10 仅重点核对批次变更恢复元数据/存储与原件哈希匹配；T12 仅重点核对外层离开与返回守卫协调器；账户切换、品牌/记账交互与智能整理仅重点核对受影响组件、查询/状态辅助文件及对应测试，不代表对其他业务域无关源码执行全量逐行代码复审。

| main Kotlin 文件 | 核对覆盖 |
|---|---|
| [app/src/main/java/com/yansuu1/jizhang/launcher/AndroidLauncherComponentStore.kt](app/src/main/java/com/yansuu1/jizhang/launcher/AndroidLauncherComponentStore.kt) | PackageManager activity-alias 组件状态读写与批次支持；P001 |
| [app/src/main/java/com/yansuu1/jizhang/launcher/DataStoreLauncherIconPreferenceStore.kt](app/src/main/java/com/yansuu1/jizhang/launcher/DataStoreLauncherIconPreferenceStore.kt) | 桌面图标用户偏好 DataStore 持久化；P001 |
| [app/src/main/java/com/yansuu1/jizhang/launcher/LauncherIconController.kt](app/src/main/java/com/yansuu1/jizhang/launcher/LauncherIconController.kt) | 六款桌面图标别名调度、先启后停保护、降级恢复与状态回读；P001 |
| [app/src/main/java/com/yansuu1/jizhang/MainActivity.kt](app/src/main/java/com/yansuu1/jizhang/MainActivity.kt) | 启动、会话、主题/配色/系统动态、全局401；§3 |
| [app/src/main/java/com/yansuu1/jizhang/net/ApiClient.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiClient.kt) | URL、Cookie、认证、HTTP、下载/二进制、错误、streamSse；§3/6 |
| [app/src/main/java/com/yansuu1/jizhang/net/ApiRequestIdentity.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiRequestIdentity.kt) | 请求会话归属快照（baseUrl与代次generation，无密码/Cookie）；§3 |
| [app/src/main/java/com/yansuu1/jizhang/net/ApiRequestOwner.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiRequestOwner.kt) | 线程安全代次所有权管理器（capture/advance/isCurrent/ifCurrent）；§3 |
| [app/src/main/java/com/yansuu1/jizhang/net/ApiTransport.kt](app/src/main/java/com/yansuu1/jizhang/net/ApiTransport.kt) | 统一网络传输门控，OkHttp Call即时取消与会话代次隔离；§3/6 |
| [app/src/main/java/com/yansuu1/jizhang/net/CancellableBlockingFlow.kt](app/src/main/java/com/yansuu1/jizhang/net/CancellableBlockingFlow.kt) | 运行于 IO 线程的阻塞式数据读取流，由独立所有者协程在取消时触发 OkHttp Call.cancel() 实施中断，非无阻塞事件驱动解析器；§6 |
| [app/src/main/java/com/yansuu1/jizhang/net/SseParser.kt](app/src/main/java/com/yansuu1/jizhang/net/SseParser.kt) | 有界行/事件/状态机 SSE 解析器，支持 CRLF/CR/LF 分隔与未完行丢弃；§6 |
| [app/src/main/java/com/yansuu1/jizhang/repo/AdminRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/AdminRepository.kt) | 分类/账户/标签管理；模板由 BudgetRepository 接入；§4 |
| [app/src/main/java/com/yansuu1/jizhang/repo/AssistantRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/AssistantRepository.kt) | 助理流式/快照/取消/消息/Provider API；导入批次创建显式analyse字段并核对响应conversationId/batchId及完整确认结果；§6 |
| [app/src/main/java/com/yansuu1/jizhang/repo/AssistantStreamingModels.kt](app/src/main/java/com/yansuu1/jizhang/repo/AssistantStreamingModels.kt) | 流式 GenerationSnapshot、SSE 事件、输入密封类与 DTO；§6 |
| [app/src/main/java/com/yansuu1/jizhang/repo/AuthRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/AuthRepository.kt) | 登录/me/退出/改密；§3 |
| [app/src/main/java/com/yansuu1/jizhang/repo/BudgetRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/BudgetRepository.kt) | 工资/预算/模板/设置；同文件含RecurringRepository；§4/5 |
| [app/src/main/java/com/yansuu1/jizhang/repo/ItemPhotoUploader.kt](app/src/main/java/com/yansuu1/jizhang/repo/ItemPhotoUploader.kt) | 二进制照片上传封装（注释旧实现不能当事实）；§5 |
| [app/src/main/java/com/yansuu1/jizhang/repo/ItemRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/ItemRepository.kt) | 物品/照片/抠图API；§5 |
| [app/src/main/java/com/yansuu1/jizhang/repo/LedgerRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/LedgerRepository.kt) | 账单/退款关联/账户余额/统计/转账/回收站；§4/5 |
| [app/src/main/java/com/yansuu1/jizhang/repo/OrganizationRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/OrganizationRepository.kt) | 智能整理 run/card/apply/undo；支持 background 与 clientRequestId 异步启动、进度轮询、审查卡片、单次确认与条件撤销；A105–A106 |
| [app/src/main/java/com/yansuu1/jizhang/repo/PortabilityRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/PortabilityRepository.kt) | CSV、平台文件、备份；§5 |
| [app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/AssistantTab.kt) | 对话/流式气泡/追问/附件/操作卡/平台导入卡；导入仅确认成功后通知账簿失效；§6 |
| [app/src/main/java/com/yansuu1/jizhang/ui/BudgetTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/BudgetTab.kt) | 预算周期/模块概览/工资模板入口；§4 |
| [app/src/main/java/com/yansuu1/jizhang/ui/Buttons.kt](app/src/main/java/com/yansuu1/jizhang/ui/Buttons.kt) | 共享主次按钮及按下动态；P027 |
| [app/src/main/java/com/yansuu1/jizhang/ui/Cards.kt](app/src/main/java/com/yansuu1/jizhang/ui/Cards.kt) | 共享卡片展示，不新增财务逻辑；§3/4 |
| [app/src/main/java/com/yansuu1/jizhang/ui/Charts.kt](app/src/main/java/com/yansuu1/jizhang/ui/Charts.kt) | 趋势/占比图与明细展示；§4 |
| [app/src/main/java/com/yansuu1/jizhang/ui/DashboardBalancesHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/DashboardBalancesHelper.kt) | 首页余额 DTO 解码（服务端权威 total、防隐式 0 抛错）、代次所有权协调；L01.02 |
| [app/src/main/java/com/yansuu1/jizhang/ui/DashboardTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DashboardTab.kt) | 首页财务/真实账户余额行/本月计划与统计入口/非导航预算摘要/待确认/最近账单；§4 |
| [app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/DataTab.kt) | 导出、导入、平台预览、备份；有效CSV/平台确认后通知账簿失效；D001–D026 |
| [app/src/main/java/com/yansuu1/jizhang/ui/DocumentFiles.kt](app/src/main/java/com/yansuu1/jizhang/ui/DocumentFiles.kt) | SAF名称/CSV校验/受限读取；D007/I013/A016 |
| [app/src/main/java/com/yansuu1/jizhang/ui/FinanceComponents.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinanceComponents.kt) | 财务分类图标与公共财务胶囊组件（Ardot Token）；P024/§4 |
| [app/src/main/java/com/yansuu1/jizhang/ui/format.kt](app/src/main/java/com/yansuu1/jizhang/ui/format.kt) | 元/日期格式、非宽松日期解析；P034/P035 |
| [app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ItemsTab.kt) | 物品全部流程，SettingsFull 桌面图标切换/AppearanceSection；§3/5 |
| [app/src/main/java/com/yansuu1/jizhang/ui/LauncherIconPicker.kt](app/src/main/java/com/yansuu1/jizhang/ui/LauncherIconPicker.kt) | 六款桌面图标设置选择器卡片、真实组件状态回读与切换交互；P001 |
| [app/src/main/java/com/yansuu1/jizhang/ui/LedgerLinkPicker.kt](app/src/main/java/com/yansuu1/jizhang/ui/LedgerLinkPicker.kt) | 退款/物品关联账单选择；§4/5 |
| [app/src/main/java/com/yansuu1/jizhang/ui/LoginScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/LoginScreen.kt) | 冷启动登录/服务器页；P005–P011 |
| [app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt](app/src/main/java/com/yansuu1/jizhang/ui/MainShell.kt) | 4+1导航（首页/账单/＋/计划/我的）、来源归还的 AI 二级页、全屏账单编辑对话框/刷新令牌分发；P017–P022 |
| [app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManageTab.kt) | 分类/账户/标签，TemplatesTab；§4 |
| [app/src/main/java/com/yansuu1/jizhang/ui/MotionTokens.kt](app/src/main/java/com/yansuu1/jizhang/ui/MotionTokens.kt) | 动态参数/reduced策略；P025–P027 |
| [app/src/main/java/com/yansuu1/jizhang/ui/NavigationLeaveGuard.kt](app/src/main/java/com/yansuu1/jizhang/ui/NavigationLeaveGuard.kt) | 外层底栏切换与系统返回集中守卫（NavigationLeaveCoordinator、LeaveGuard、ActiveNavigationHandlers）；P017 |
| [app/src/main/java/com/yansuu1/jizhang/ui/MyTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/MyTab.kt) | “记账与计划/更多工具”二级分组；AI入口委托 MainShell 保存来源；外观持久化辅助；P019–P024 |
| [app/src/main/java/com/yansuu1/jizhang/ui/PendingTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/PendingTab.kt) | 生成/待确认/核对/确认忽略；R010–R018 |
| [app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettings.kt) | Provider草稿/保存/测试/密钥；A038–A062 |
| [app/src/main/java/com/yansuu1/jizhang/repo/FinancialPlanModels.kt](app/src/main/java/com/yansuu1/jizhang/repo/FinancialPlanModels.kt) | B03严格计划/分析/预测/版本DTO解码，不重算财务规则 |
| [app/src/main/java/com/yansuu1/jizhang/repo/FinancialPlanRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/FinancialPlanRepository.kt) | B03当前计划GET、显式preview POST与CAS保存PUT |
| [app/src/main/java/com/yansuu1/jizhang/ui/ExistingSalaryExecutionSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/ExistingSalaryExecutionSheet.kt) | B03.09已有工资选择、分页、服务端预览与明确确认，结果未知时原请求重放；跨旧入口并发仍须专项修复 |
| [app/src/main/java/com/yansuu1/jizhang/ui/FinancialExecutionHistorySheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialExecutionHistorySheet.kt) | B03.09确认执行周期/修订分页与冻结只读详情，不创建记录 |
| [app/src/main/java/com/yansuu1/jizhang/ui/FinancialExecutionHistoryState.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialExecutionHistoryState.kt) | B03.09独立请求代次、保留行的分页/错误状态、基点比例与周期时区展示 |
| [app/src/main/java/com/yansuu1/jizhang/ui/FinancialPlanState.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialPlanState.kt) | B03精确金额解析、草稿匹配、教育提示 |
| [app/src/main/java/com/yansuu1/jizhang/ui/FinancialPlanWorkOwner.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialPlanWorkOwner.kt) | B03请求代次/服务作用域/销毁守卫与保存回包核验 |
| [app/src/main/java/com/yansuu1/jizhang/ui/FinancialPlanScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialPlanScreen.kt) | B03独立计划页、4项用途/手动储备进度/12月假设预测/提示与保存重试 |
| [app/src/main/java/com/yansuu1/jizhang/repo/ProviderModels.kt](app/src/main/java/com/yansuu1/jizhang/repo/ProviderModels.kt) | 模型列表严格DTO解析、2000项上限与去重、大小写不敏感搜索；A041 |
| [app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettingsHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/ProviderSettingsHelper.kt) | Provider 设置辅助解析、Base URL 补全与默认路径计算；A057 |
| [app/src/main/java/com/yansuu1/jizhang/ui/RecurringRulesTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/RecurringRulesTab.kt) | 规则CRUD启停及脏草稿/结果核对；R001–R009 |
| [app/src/main/java/com/yansuu1/jizhang/ui/RecordingDefaults.kt](app/src/main/java/com/yansuu1/jizhang/ui/RecordingDefaults.kt) | 纯账户默认解析（活跃最近账户/首个活跃账户/退款固定原账户）及按服务端+用户隔离的偏好存储；L04.01 |
| [app/src/main/java/com/yansuu1/jizhang/ui/SalarySheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalarySheet.kt) | 工资历史/表单/分配；§4 |
| [app/src/main/java/com/yansuu1/jizhang/ui/SalaryTemplateState.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalaryTemplateState.kt) | 工资模板可用性判定（activeCategoryIds 校验）；S01.02 |
| [app/src/main/java/com/yansuu1/jizhang/ui/SettingsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/SettingsTab.kt) | 我的退出辅助；P033 |
| [app/src/main/java/com/yansuu1/jizhang/ui/StatsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/StatsTab.kt) | 自然月趋势/分类统计；§4 |
| [app/src/main/java/com/yansuu1/jizhang/ui/ThemePrefs.kt](app/src/main/java/com/yansuu1/jizhang/ui/ThemePrefs.kt) | 主题/配色/减少动态本地偏好；P023–P026 |
| [app/src/main/java/com/yansuu1/jizhang/ui/TransactionDetailLoadOwner.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionDetailLoadOwner.kt) | 账单详情异步加载票据与单调所有权守卫；L03.01 |
| [app/src/main/java/com/yansuu1/jizhang/ui/TransactionDetailScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionDetailScreen.kt) | 居中账单详情/退款关联/记录退款操作/编辑入口；A105复用readOnly模式隐藏变更操作；§4/9 |
| [app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditorHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditorHelper.kt) | 账单草稿快照、字段校验、9字段完整 payload、同步门控防重入提交器；L04.08 |
| [app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditSheet.kt) | 新建编辑/退款预填/固定金额键盘/默认账户记忆/草稿安全的更多字段折叠/顶部浮层错误；§4/7 |
| [app/src/main/java/com/yansuu1/jizhang/ui/TransactionMonthLoader.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionMonthLoader.kt) | 月份及搜索500笔分批完整加载、逐页搜索版本校验、每日统计严格解码与笔数一致性校验；L02.07/L02.10 |
| [app/src/main/java/com/yansuu1/jizhang/ui/TransactionQueryHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionQueryHelper.kt) | 账单不可变查询、账户选项/名称回退、分页纠正、列表/元数据请求代次与状态隔离；L02 |
| [app/src/main/java/com/yansuu1/jizhang/ui/TransactionRefundSeedHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionRefundSeedHelper.kt) | 原支出可退款校验、到账账户活跃判定与退款草稿种子构建；L04.01 |
| [app/src/main/java/com/yansuu1/jizhang/ui/TransactionTopErrorHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionTopErrorHelper.kt) | 编辑器顶部错误浮层事件模型、无障碍推荐时长与同文重置计时控制器；L04.08 |
| [app/src/main/java/com/yansuu1/jizhang/ui/TransfersTrashTabs.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransfersTrashTabs.kt) | 转账和回收站；T001–T014 |
| [app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchRecoveryState.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchRecoveryState.kt) | T10批次变更恢复元数据/状态与 `matchBatchOriginals` 哈希一一匹配；A005/A015/A030/A104 |
| [app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchRecoveryStore.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchRecoveryStore.kt) | T10按server/user/conversation/batch范围持久化变更元数据（不存bytes/reviewToken）；A005/A015/A030/A104 |
| [app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchImportWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchImportWorkspace.kt) | 全屏多文件融合导入工作区（500有界分页、validateAndReduceBatchPages 5页完整性校验与有界重试、owner+ticket守卫review/confirm/恢复、未知分析态GET查询、Provider和原件SHA就绪后显式AI、权威审核与原子确认）；A021/A023/A026–A031/A104 |
| [app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchModels.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantBatchModels.kt) | 融合导入批次强类型 DTO、platform_order/occurrence 严格 identityKind 守卫（拒 unknown）、BigDecimal 严格整数/长整型解析（2^63 边界 fail-close）、ReviewSummaryCounts 独立统计维度、纯函数分页校验器 validateAndReduceBatchPages 与非空 viewRevision fail-close；A016/A022/A023/A024/A027/A104 |
| [app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantConversationHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantConversationHelper.kt) | 聊天会话管理、选项错误判定（409锁定不解锁）、历史消息合并与去重；A005/A010–A013 |
| [app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantDuplicateState.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantDuplicateState.kt) | 导入疑似重复账单就地对比状态与行级锁定；A101–A103 |
| [app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantImportState.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantImportState.kt) | AI导入有界解码/选择/筛选/request gate；A005/A026–A029 |
| [app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantImportWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantImportWorkspace.kt) | 全屏导入/分类/确认、操作详情与附件限制；A016/A021/A023/A026–A030 |
| [app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantOrganizationModels.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantOrganizationModels.kt) | 整理 run/card/action/note/apply 严格 DTO 解码，未知动作类型 fail-close；A105–A106 |
| [app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantOrganizationState.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantOrganizationState.kt) | 日期范围快捷项/校验、默认最多 100 项选择、选择切换与错误映射；A105–A106 |
| [app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantOrganizationWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantOrganizationWorkspace.kt) | 全屏智能整理：范围选择、完整分析态、逐笔分类/标签审查、独立备注/新分类建议、单次确认、应用结果与条件撤销；A105–A106 |
| [app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantStreamReducer.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantStreamReducer.kt) | 流式状态机 Reducer、选项锁定与增量正文合并；A011/A012 |
| [app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantStreamingComponents.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantStreamingComponents.kt) | 流式卡片组件、状态徽章、单选追问卡与停止生成按钮；A011/A018–A022 |
| [app/src/main/java/com/yansuu1/jizhang/ui/theme/JizhangTheme.kt](app/src/main/java/com/yansuu1/jizhang/ui/theme/JizhangTheme.kt) | 配色/财务语义/主题Token；P024 |

| [JsonNumberReaders.kt](app/src/main/java/com/yansuu1/jizhang/net/JsonNumberReaders.kt) | 共享精确整型解码与安全范围检查；金额/窗口wire边界 |
| [FinancialExecutionModels.kt](app/src/main/java/com/yansuu1/jizhang/repo/FinancialExecutionModels.kt) | 工资周期/规则/用途/退款执行DTO；B03 |
| [FinancialExecutionRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/FinancialExecutionRepository.kt) | 已认证理财执行/操作重放API；B03 |
| [MonthlyPlanModels.kt](app/src/main/java/com/yansuu1/jizhang/repo/MonthlyPlanModels.kt) | C2精确合同解码，空状态明确null、待核对不发布精确剩余；B03.12 |
| [MonthlyPlanRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/MonthlyPlanRepository.kt) | GET monthly-plan与旧服务器不可用边界；B03.12 |
| [StatsRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/StatsRepository.kt) | 统计window/精确分类账户/历史趋势anchor/旧pool API；B02 |
| [AssistantScreenState.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/assistant/AssistantScreenState.kt) | AI助理二级工作区所有权和屏幕状态；A001/A104 |
| [FinancialCategoryMappingSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialCategoryMappingSheet.kt) | 必要/随心/待归类规则与折叠诊断；B03 |
| [FinancialConfigSheet.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialConfigSheet.kt) | 规划比例、必要基准、目标月数和CAS设置；B03 |
| [FinancialExecutionSheetState.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialExecutionSheetState.kt) | 理财弹窗草稿/写入/结果核对辅助；B03 |
| [FinancialExecutionWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialExecutionWorkspace.kt) | 旧四用途执行、来源核对与退款工具；B03 |
| [FinancialHostScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialHostScreen.kt) | 月计划默认页和四个retained slots，仅place当前工具；B03.08 |
| [FinancialPrefs.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialPrefs.kt) | 按server+user隔离的认证作用域/未决操作存储；B03/S01 |
| [FinancialRefundSplitDialog.kt](app/src/main/java/com/yansuu1/jizhang/ui/FinancialRefundSplitDialog.kt) | 明确退款分摊和原请求重放；B03 |
| [MonthlyPlanWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/MonthlyPlanWorkspace.kt) | 默认月计划、服务端金额/质量状态/分类及旧工具；B03.12 |
| [SalaryFinancialPrompt.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalaryFinancialPrompt.kt) | 工资保存后独立预览/确认纳入计划；S01 |
| [SalaryOperationReplay.kt](app/src/main/java/com/yansuu1/jizhang/ui/SalaryOperationReplay.kt) | 工资仅keyed提交、能力fail-close和作用域重放；S01 |
| [StatsWindow.kt](app/src/main/java/com/yansuu1/jizhang/ui/StatsWindow.kt) | 服务端窗口解码/字幕与读作用域/代次守卫；B02 |
| [TransactionDrilldownQuery.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionDrilldownQuery.kt) | 精确条件、完整分页/服务端合计和认证范围核验；B02.13 |
| [TransactionDrilldownScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionDrilldownScreen.kt) | 分类全部账单只读下钻与详情优先Back；B02.13 |
| [TransactionEditorStateHelper.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionEditorStateHelper.kt) | 单笔用途草稿/CAS/请求恢复；L04.11 |
| [TransactionsTab.kt](app/src/main/java/com/yansuu1/jizhang/ui/TransactionsTab.kt) | 月账单/账户筛选与完整列表、每日统计；L02 |
| [FinancialGoalModels.kt](app/src/main/java/com/yansuu1/jizhang/repo/FinancialGoalModels.kt) | C4手动存钱与投资进度严格DTO解码，区分手动来源与未开始状态；B03.13 |
| [FinancialGoalRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/FinancialGoalRepository.kt) | 手动目标进度与存取记录API、CAS与重放；B03.13 |
| [ManualGoalInput.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManualGoalInput.kt) | 手动存钱与投资金额精确转分解析器（BigDecimal乘100与JS安全整数范围校验，拒绝第三位小数与非数字）；B03.13 |
| [ManualGoalOperationReplay.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManualGoalOperationReplay.kt) | 手动存钱与投资四种写入的重放协调器、Gateway/Store接口及未知结果恢复；B03.13 |
| [ManualGoalProgressReadState.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManualGoalProgressReadState.kt) | 手动目标进度关联冻结周期/统计窗口上下文 ManualGoalWindowContext 及严格回显校验 requireManualGoalWindow；B03.12/B03.13 |
| [ManualGoalEntryListState.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManualGoalEntryListState.kt) | 手动存钱与投资明细有界游标分页状态机与单调拼接校验；B03.13 |
| [ManualGoalProgressWorkspace.kt](app/src/main/java/com/yansuu1/jizhang/ui/ManualGoalProgressWorkspace.kt) | 应急金/投资本金手动进度、存取记录与整段非负校验；B03.13 |
| [PlatformImportState.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/imports/PlatformImportState.kt) | T09新平台导入 FinancialScope/ApiRequestIdentity/source/conversation owner、工作区引用、精确同bytes重试及owner-bound request tickets；D014/D015/A005 |
| [PlatformImportHost.kt](app/src/main/java/com/yansuu1/jizhang/ui/feature/imports/PlatformImportHost.kt) | C5统一新平台导入宿主，复用多文件批次工作区，analyse=false人工入口、owner/ticket守卫与同会话/原件重试；D014/D015 |

### 11.2 全部服务端 route 文件

实际为**14个route .ts文件**；health和API-only未匹配路由处理注册于app.ts，另外列出。

| route 文件 | 覆盖域和状态 |
|---|---|
| [ai.ts](../../packages/server/src/routes/ai.ts) | Provider GET/PUT config、test；独立draft/month评；旧整理preview/apply/undo；智能整理 runs/run/status/card/apply/operation undo；§6（标记直连/间接/服务端） |
| [assistant.ts](../../packages/server/src/routes/assistant.ts) | tools、conversation/message、archive、action确认/取消；§6 |
| [auth.ts](../../packages/server/src/routes/auth.ts) | login/logout/me/password；§3 |
| [budget.ts](../../packages/server/src/routes/budget.ts) | 工资、分配、预算概览、模板、周期settings；§4/3 |
| [import-batches.ts](../../packages/server/src/routes/import-batches.ts) | 多文件融合导入批次 11 项端点（创建/查询/分页行/重复对比/分类建议/审核/分析/文件运维/确认/取消）；§6 |
| [item-cutouts.ts](../../packages/server/src/routes/item-cutouts.ts) | 创建/状态/取消/候选预览与原图；§5 |
| [items.ts](../../packages/server/src/routes/items.ts) | 物品查询/概要/CRUD、售出/退役、照片；§5 |
| [master-data.ts](../../packages/server/src/routes/master-data.ts) | 分类/账户/标签、排序/删除影响；§4 |
| [portability.ts](../../packages/server/src/routes/portability.ts) | 4导出、2CSV导入、平台导入、备份list/create；§5 |
| [recurring.ts](../../packages/server/src/routes/recurring.ts) | 规则/启停/生成/待确认/历史/确认忽略；§5 |
| [stats.ts](../../packages/server/src/routes/stats.ts) | 自然月趋势、分类占比等统计；§4 |
| [transactions.ts](../../packages/server/src/routes/transactions.ts) | 账单列表与条数 total、单条/CRUD/退款关联；无独立财务汇总接口；§4 |
| [transfers.ts](../../packages/server/src/routes/transfers.ts) | 查询/单条/CRUD；§5 |
| [trash.ts](../../packages/server/src/routes/trash.ts) | 软删账单list/restore/purge/bulk；§5 |
| [app.ts](../../packages/server/src/app.ts) | GET /api/v1/health（仅服务端，无登录连通性测试按钮）；API注册、认证及8MiB bodyLimit；非API路径JSON404，§3/9 |

### 11.3 其他已核对来源

- [app/build.gradle.kts](app/build.gradle.kts)：SDK/版本/签名；[main Manifest](app/src/main/AndroidManifest.xml)：权限/备份/入口。
- [debug Manifest](app/src/debug/AndroidManifest.xml)、[DemoActivity.kt](app/src/debug/java/com/yansuu1/jizhang/DemoActivity.kt)：仅debug预览，非正常用户入口。
- 后端services与shared规则是上述功能表中的验证依据；尤其CSV/平台解析、退款/余额/预算、AI指纹和物品生命周期不能只查Android文字。
- [cutout worker](../../packages/cutout/app/)：SAM2候选、容量/输入/任务TTL；其默认值不等于部署已启用。
- 审计原始材料：[平台](../../.trellis/tasks/10-10-android-ui-redesign/research/function-inventory-platform.md)、[账务](../../.trellis/tasks/10-10-android-ui-redesign/research/function-inventory-ledger.md)、[操作](../../.trellis/tasks/10-10-android-ui-redesign/research/function-inventory-operations.md)、[AI](../../.trellis/tasks/10-10-android-ui-redesign/research/function-inventory-assistant.md)。用户功能正文已直接收录本文，研究链接用于追踪依据，不代替正文。

<a id="maintenance"></a>
### 11.4 多用户新增主 Kotlin 源码

| 源码 | 当前职责与稳定ID |
|---|---|
| [AuthenticatedUser.kt](app/src/main/java/com/yansuu1/jizhang/net/AuthenticatedUser.kt) | 真实身份/过期/能力读取、认证错误文案；P012/P045 |
| [RegistrationDraft.kt](app/src/main/java/com/yansuu1/jizhang/repo/RegistrationDraft.kt) | 注册字段校验与请求体；P042 |
| [RegistrationScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/RegistrationScreen.kt) | 手机邀请码注册界面；P042 |
| [InvitationRepository.kt](app/src/main/java/com/yansuu1/jizhang/repo/InvitationRepository.kt) | 邀请列表/创建/撤销和DTO；P043 |
| [InvitationManagementScreen.kt](app/src/main/java/com/yansuu1/jizhang/ui/InvitationManagementScreen.kt) | 能力门控、明文一次复制、状态与撤销；P043/P045 |

## 12. 维护流程、记录模板和变更日志

**2026-11-05 变更记录（多用户邀请码）：** 新增 P042–P045；认证响应保留兼容字段并增加不可变身份/权限，注册和登录不携带旧Cookie且拒绝重定向、先验证响应再接收会话；主壳按登录身份重建；财务与AI导入未决操作使用新的用户ID命名空间，旧记录留存不自动迁移。邀请码表单/列表/单次明文复制/撤销入口已写入源码。新增 `MultiuserAuthenticationTest`，验证注册校验、旧响应权限回退、Cookie失败隔离/成功接收/缺失拒绝、重定向阻断、同名不同ID隔离、邀请码状态；更新既有登录401测试使用真实POST方法。当前本机Gradle未进入构建（wrapper锁超时、SDK缺失）；CI和设备结果单独记录。

### 12.1 同批更新规则

1. 修改Android UI/Repository/网络/Manifest或相关API/service/shared parser时，先找受影响稳定ID。
2. 同批更新功能行为、所有表单字段/默认值/校验、入口/返回、状态/分页、限制、API和源码证据；有新增能力追加ID，不重排旧ID。
3. 接入原服务端能力时，把“仅服务端/间接工具”改为真实入口，并补UI调用证据；删功能保留原ID和“已移除（日期/原因）”，旧ID永不复用。
4. 修复缺口时同时修改正文和第9节，记录修复日期/源码事实；未设备验证不能写“实测通过”。
5. 修改文件限额要同时查手机读取、Fastify bodyLimit、路由/service、worker及Base64膨胀；修改删除/生成要查全库作用范围和确认文案。
6. 重新核查后才推进核对日期，并更新变更日志、主Kotlin/route覆盖表及下方条目数；维护触发来自代码变更，没有后台自动守护程序。
7. 交付前检查链接能解析、稳定ID唯一、全部main Kotlin/route有覆盖、设计与事实分开，设备/服务证据独立记录。

项目入口：[仓库README](../../README.md)、[客户端README](../README.md)；维护要求见[AGENTS.md](../../AGENTS.md)和[native-delivery规范](../../.trellis/spec/backend/native-delivery.md)。

### 12.2 新增或变更条目模板

| 项目 | 填写内容 |
|---|---|
| 稳定ID | 原ID或所属域下一个未使用序号 |
| 名称/状态 | 直接UI / 间接工具 / 仅服务端 / 已移除；是否源码缺口、设备未验 |
| 入口/返回 | 一级与二级入口、所有退出入口、保存成功去向 |
| 字段 | 名称、类型、默认、可空、选项、隐藏/只读条件 |
| 校验 | 本地与服务器分别记录，数字/日期/长度/引用及限额 |
| 动作/状态 | 读取/新增/编辑/删除/确认/取消/重试；busy、空、错、不确定结果 |
| 数据/API | 方法/路径/payload/返回；是否财务写入、全库/当前显示范围 |
| 限制/证据 | 源码链接、已知缺口、设备版本/步骤/结果（未测明确写未测） |
| 日期/日志 | 源码核对日期与运行验证日期分别记录，描述变化 |

### 12.3 变更日志

**2026-11-06 native outcome continuation (backend/iOS; local contract recheck):** Updated A020/A093/A113, API matrices, fields/validation and known Android gaps for the closed native-completions DTO. Migration025 adds nullable CSV confirmed_at without rewriting024 or inventing legacy times. Confirmed import receipts must not predate the original entry; photo current-state and export server-read attribution remain limited. Request/source-receipt dedupe, atomic original-task binding, later consent and inherited daily read-only scope are preserved. Android source is unchanged and has no caller/callback/UI. Backend39 workspace +26 migration focused cases passed; root subsequently verified local build/lint/typecheck plus405 shared +1380 server tests (69 suites), with logs under clients/ios/build/harness-quality/final-*.log. Final macOS/IPA is recorded separately and these numbers do not imply Android UI/device verification. No new device/live-provider/production evidence; historical counts/dates and stable IDs are preserved.

**2026-11-06 对话工作区及 iOS 提醒（Android 契约局部复核）：** 保留并更新 A020/A093/A107–A116 的服务端字段/约束及 Android 消费边界，登记 `workspace-v1` 明确协商、权威分页选择、草案替代、确认后续接、只读日复盘、受信任原生入口与轨迹路由；补充通用 CSV 原件哈希/CAS 预览确认及抠图 JPEG/PNG 输入兼容。Android 源码未改，既有 v1/legacy、WebP 上传和独立导入/整理保持；未新增 Android 工作区卡片、原生入口处理或每日通知，不宣称与 iOS 对齐。仅推进上述复核行，其他日期、历史数量和自动化/设备记录保持。代码源及检查边界见[本轮交接](../../.trellis/tasks/11-04-ios-assistant/research/harness-android-inventory-handoff.md)；最终 CI 与 IPA 由主任务另录，不能推导真机、真实模型或生产部署成功。

**2026-11-06 助手执行可靠性（局部源码核对）：** 更新A020/A093/A107/A115/A116及§6.5/9.3：记录8次有界模型决策、业务参数2次纠错、立即保存成功读取、重复查询收口与后台整理任务移交；补充长文本摘要、退款关联分页与自然月统计的month默认语义。写操作仍需用户确认，模板不恢复。Android原生代码未变，保留通用结果展示、聊天任务观察和跨页刷新缺口，独立整理工作区原有15分钟观察不改。仅推进这些条目的源码日期；全库日期、总数、历史测试和设备证据不重算。本轮隔离复现与源码核对见[可靠性审查](../../.trellis/tasks/11-04-ios-assistant/research/assistant-reliability-review.md)，最终自动化门禁由主任务记录；无真实Provider调用、生产部署或Android真机验证。

**2026-11-05 助手全业务工具目录补齐（局部源码核对）：** 在原稳定ID上更新A020/A021/A024、A072/A073/A077/A084/A087，追加A107–A116十个业务能力组；准确列出新工具和参数/CAS/分页/历史整理限制。A084保留ID并标退役；A077仅canonical四用途收入，不重启旧模板分配。复核Android generic card与Repository未封闭toolName、结果摘要不遍历数组、普通工具成功不发跨页刷新信号，分别记录兼容和缺口；没有新增Android代码、页面、route或工具目录UI。此前314/322功能与30工具、126/137API等数字全部保留为历史统计；本轮不重算全库。服务端/客户端CI结果由本轮任务单独记录，此记录不构成真实Provider、设备安装或生产部署证据。

**2026-10-30 C2/C3局部实施：** C2默认本月计划与工资模板/用途精简，后续严格空状态解码与退款原因修复；C3服务端window、精确账户/分类、expenseCount、默认6月与历史锚点、毛支出文案、完整下钻与无需AI复盘，结余池/逐期明细归入高级预算。保留原ID并新增B02.12–13；主Kotlin目录按实际97个路径补齐（非全库行为重审）。shared385测试/build/lint、server1018测试/lint/typecheck/build通过；Android初次C3门禁49套505项/0失败，后续修复最终门禁见[任务状态](../../.trellis/tasks/10-29-core-simplify-statistics/implementation-status.md)。设备范围/返回/小屏/TalkBack待验；没有装机、生产部署或账务数据变更。

**2026-10-22 账单布局与每日统计：** L02.01/04/07/10：刷新移至右上取代多余记一笔，月份置于账单标题旁，去除页码和上下页但后台完整分批读取整月；账户仅保留选择框。每日日期旁显示服务端同筛选支出/收入（退款仍计入收入，工资/转账不混入）。新增 daily-summary 接口及设备时区参数，需单独部署服务端才可使用统计；不自动部署/装机。完整性失败不截断成成功；汇总缺失显示“—”而非零。当前本地验证：Android 21 suites / 243 tests 全通过（新增28项），assembleDebug/lintDebug通过（lint 0 errors / 43 warnings / 21 information，非零warnings；本轮账单/loader/repo/ListChoice无lint条目）；server 735 / shared 187 tests及server typecheck/lint通过。新APK 22,212,245字节，SHA-256 `35fbfe8bdf75e82c4deb9c4d369224a051b2aa405380f01b123175b1ca73f9f7`。验证记录见[本轮状态](../../.trellis/tasks/10-22-android-bill-daily-layout/implementation-status.md)，不以构建通过代替设备实测。

| 日期 | 变更 | 证据等级 |
|---|---|---|
| 2026-11-04（工资与用途协议局部复核） | 保留 S01.02/04–09/12、L04.11 稳定 ID；修正工资/API/缺口为 Android 旧模板请求与当前服务端新基金合同不兼容，并区分已提交旧请求原键重放、未提交旧请求 410 及旧用途缺基金 CAS 的 409；不声称四用途 Android UI 已实现。不推进全库审计日期。 | 本轮仅局部源码核对；工资实现代理报告其执行时 4 文件 32 测试通过，交易实现代理报告其执行时 3 文件 139 测试通过，服务端 lint/typecheck 由代理报告通过；并行变化下最终整合待复核。未新增 Android JVM/设备/部署验证，设备待验。 |
| 2026-11-01（账单搜索局部复核） | 保留 L02 稳定 ID：新增名称或金额搜索，默认全部历史、可切所选月并组合账户/收支类型；清空回月视图；逐页和月汇总校验 `searchVersion=1` 与64位 `searchRevision` 快照一致性，全历史不请求汇总且日期含年份；保留完整分页安全上限和查询代次隔离。 | 本地 Android JVM 63 套/580 项通过，lintDebug 0 error/43 warnings，assembleDebug 通过（APK 22,112,428 字节，SHA-256 `E29593BE7FE956F25C142514CA1854EEA3CBD19251EB7924A34CEC66D76B7C4A`）；连线测试不等于触摸验证。配套服务端须单独部署，未安装或进行设备交互验证。 |
| 2026-10-31（T12财务与导入外层离开守卫） | P017–P020/B03.08/S01.10/A001/D014：新增 `NavigationLeaveGuard.kt`（`NavigationLeaveCoordinator`、`LeaveGuard` 与 `ActiveNavigationHandlers`），严格遵循同一 owner 未决请求只保留首次目标、代次提升后拒绝旧 owner 延迟允许、失活仅能注销自身 ownerKey；MainShell 底栏切换与底层系统返回优先咨询 leaveCoordinator；FinancialHostScreen（联动 MonthlyPlan/ManualGoals、FinancialExecution 及 Scenario）在包含脏草稿或打开手动目标时向外注册离开守卫并分层拦截返回；PlatformImportHost 在所有分支前注册，且 AssistantBatchImportWorkspace 内部包含草稿、内存原件、提交中或未决恢复状态（UNKNOWN）时弹窗二次确认；离开只停止本地等待，绝不删除重放元数据或撤销服务端提交。 | 单元测试 `NavigationLeaveGuardTest`（覆盖底栏拦截/允许恰好一次、重复点击防重弹、旧owner延迟允许失效、内层先于外层关闭）与 `FinancialHostAndWorkOwnerTest` 全部通过；系统 Back 硬件按键、TalkBack 与手势离开仍 DEVICE PENDING，未部署/未真机安装。 |
| 2026-10-31（T07所有财务写入后的摘要失效刷新） | B03.08–B03.13/S01.08/S01.12/B02.12：全链路接通 MainShell `ledgerRefreshToken` 失效刷新；MainShell 与 MyTab 统一将 `refreshToken` 与 `onDataChanged` 传给 FinancialHostScreen（包含 MonthlyPlanWorkspace 与 FinancialExecutionWorkspace）、StatsTab 及各工资入口；FinancialExecutionWorkspace 内部 4 个子弹窗（已存工资开启、规划配置、分类映射、退款分摊）及 confirmPeriod 确认成功均回调 onDataChanged；MonthlyPlanWorkspace 透传 ManualGoalProgressWorkspace 并在 refreshToken 自增时重读本月计划与同周期目标；SalaryFinancialPrompt 拆分 onPlanConfirmed 与 onFinished，跳过不刷新计划，确认成功递增 token；StatsTab 读取 effects 监听 refreshToken 确保同范围实际存投随之刷新；无 EventBus/全局缓存，严格复用单源代次。 | 源码静态核查通过；设备端端到端交互待验，未部署/未真机安装。 |
| 2026-10-31（T11异常优先核对与分类实体计数） | A023/A026/A028/A104：默认筛选改为“待核对”（`batchRowNeedsAttention` 综合事实冲突、疑似重复/旧账、规则异常、未分配/待批准分类；用户排除行不强求分配），“全部”视图按待核对优先、ordinal、itemId 稳定排序；空待核对行提供“查看全部 N 条”；行编辑提供“不同来源原备注”（消费 noteAlternatives）及“采用此备注”（包括空值写入 noteOverrides 且失效 review）；服务端 `import-batch-service.ts` 在 review 与 confirm 中统一定义分类计数为去重分类实体（3行同一新分类计创建1复用0；3行同一已有分类计创建0复用1）。 | 服务端 `import-batch-confirm.test.ts`(32) / `import-batch-manual-flow.test.ts`(2) 全绿；Android 单元测试 `AssistantBatchImportStateTest` 全绿；设备端长备注展开与全量列表核对操作待验，未部署/未真机安装。 |
| 2026-10-31（T10导入未知结果恢复与原件哈希匹配） | A005/A015/A022/A025/A030/A031/A104：新增 `AssistantBatchRecoveryState.kt`（`BatchMutationKind`、`BatchFileFingerprint`、`BatchMutationMetadata`、`BatchMutationState`、`AssistantBatchRecoveryState.hasUnresolvedMutation` 与生产 `matchBatchOriginals`）与 `AssistantBatchRecoveryStore.kt`（按 server/user/conversation/batch 范围持久化元数据，绝不持久化原始字节、reviewToken 或聊天内容）；分析操作发送前先持久化同键元数据，无网络/超时/401 时保留 UNKNOWN 待核对而不改键重发；`filesMismatch` 改用服务端 fileIndex + SHA-256 一一对应内容判定（同数量但内容变化即失配，每份原件只能占用一次），重新绑定原件与确认入账均使用严格匹配并按服务端顺序排序的文件集；未决恢复状态通过 `onRecoveryStateChanged` 暴露给外层离开守卫。 | 定向 JVM 用例 `AssistantBatchRecoveryStateTest`（hash 匹配一一占用/同数量异哈希/缺失/重复哈希占用、丢响应保留原键与候选文件、元数据序列化往返）与既有 `AssistantBatchNetworkContractTest` 全部通过；服务端 `import-batch-analysis.test.ts`(13) / `import-batch-regression.test.ts`(14) 通过，未改后端迁就客户端；设备端丢响应/重启/重新绑定原件与弱网路径仍 DEVICE PENDING，未部署/未真机安装。 |
| 2026-10-31（T09统一平台导入与附件所有权） | D006/D009/D014/D015、A001/A005/A007/A015/A022/A024/A025/A030/A104：Data CSV与平台批次、Assistant旧平台确认/批次确认只在完整成功时调用既有 `onDataChanged`/`ledgerRefreshToken`，普通chat send/取消/错误/未知响应不发成功信号；Data/Assistant统一 `PlatformImportHost`，显式 `analyse=false`；owner绑定FinancialScope/ApiRequestIdentity/source/入口conversation，workspaceRef保留协议conversationId，读取/写入/错误/finally由owner+ticket守卫；batch retry复用同conversation、clientRequestId及同序/同name/bytes原件，拒绝同key更换bytes；未知分析态GET查询且不变成AI可重试failed；AI仅在idle/确定failed、mutable、Provider配置启用且SHA-256原件匹配时显式操作；confirmed结果必须conversation/batch匹配且包含权威结果字段。 | 源码核对与定向JVM回归用例已更新；Android Gradle门禁待Lead复跑（本轮未运行Gradle）；server `import-batch-manual-flow.test.ts` Lead先前运行2/2通过且T09未改服务端文件；SAF取消、A/B会话、弱网/真实Provider仍 DEVICE PENDING；未部署/未真机安装。 |
| 2026-10-30（T06手动历史有界分页与全历史操作） | B03.13：新增 ManualGoalEntryListState.kt（ManualGoalEntryQuery 与 appendManualGoalEntryPage 纯函数拼接校验），明细游标分页采用 limit=100 并严格校验同 revision、游标前进与条目去重；版本变化标记 restartRequired 要求重读首屏而不丢失编辑草稿；分页失败保留当前项并支持重试；ManualGoalProgressWorkspace 接入分页状态并在存在窗口时提供“本期明细/全部历史”切换，无窗口默认全部历史；软删除条目在历史中清晰展示且不计入余额；新增 ManualGoalEntryListStateTest 覆盖 235 条三页拼接、分页失败重试、revision 变化、空页/游标停滞/非空游标契约与异常拒绝边界；服务端 financial-goals.test.ts 补充软删除及透支回滚回归测试。 | 单元测试全覆盖（ManualGoalEntryListStateTest 7项通过），源码静态核查通过；设备端分页操作待验，未部署/未真机安装。 |
| 2026-10-30（T05当前计划参考与同周期实际存投） | B03.12/B03.13/B02.12：服务端 monthlyReserveReferenceCents 彻底改为以本次捕获的 calculatedAt 经由 MonthlyPlanService 检查当前包含 now 的冻结方案，拒绝借用旧自然月方案预测，salary-source-changed 冲突时置 null；选定历史/期间窗口置 null 当前预测，消除假预测标签；新增 ManualGoalProgressReadState.kt，公开 ManualGoalWindowContext，以 requireManualGoalWindow 严格校验服务端回显范围与契约；MonthlyPlanWorkspace ready 时读取并列展示本期手动净存入与净投入，并传参窗口上下文；StatsTab 异步加载统计区间目标并在账户筛选下清晰标注“手动存投（全部目标，未按账户筛选）”且不混入账户总额与净储蓄率。 | 源码静态核查通过，服务端用例补充闭环；未部署/未真机安装。 |
| 2026-10-30（T08默认工资模板失效修复与冻结日期展示） | S01.02/S01.12/B03.12：新增 SalaryTemplateState.kt（isUsableSalaryTemplate 校验每个模块引用的分类必须在当前 activeCategoryIds 集合中且 id/modules 非空）；SalarySheet 接入活跃分类集合判定模板可用性，失效时阻止工资/计划写入并提供“修复分配模板”入口；保存收到确定分类拒绝转入修复并保留草稿；format.kt 新增 formatFrozenFinancialWindow，显式使用 IANA 时区格式化冻结区间并标明“（不含终点）”，消除设备本地时区跨日漂移；SalaryFinancialPrompt 接入该格式化函数展示冻结区间；新增 SalaryTemplateStateTest 与 FrozenFinancialWindowFormatTest；服务端回归测试验证分类不可用拒绝时零部分写入。 | 单元测试全覆盖（SalaryTemplateStateTest 3项 + FrozenFinancialWindowFormatTest 4项），源码静态核查通过；未部署/未真机安装。 |
| 2026-10-30（T04手动目标写入恢复） | B03.13 四种写入重放与未知结果恢复：新增 ManualGoalOperationReplay.kt 协调器（submit/retry/recover），管理 PUT opening / POST entry / PATCH entry / DELETE entry 四种写入的先存后发、未知结果查询恢复与原子性；FinancialGoalRepository 新增 sendExact 与 operationResult；ManualGoalProgressWorkspace 接入协调器并暴露 onDataChanged；单元测试 ManualGoalOperationReplayTest 覆盖全部重放不变式与重启后含特殊字符备注精确恢复；服务端 financial-goals.test.ts 补充同键重放与透支回滚原子性用例。 | 单元测试用例及源码核验；未部署/未装机。 |
| 2026-10-30（T02网络会话归属与取消） | P011–P015/§3/§6：新增 ApiRequestIdentity 与线程安全 ApiRequestOwner，管理请求代次归属（退出、换服务、开始新登录原子递增 generation，A→B→A 不回退）；新增 Context-free ApiTransport 门控，所有普通请求（JSON/raw/下载/SSE）统一走挂起取消边界，协程取消即时调用 Call.cancel() 并关闭响应；晚到 401 或 Set-Cookie 以 CancellationException 结束且不产生跨会话副作用；AuthRepository 与 MainActivity 接线启动时 identity 校验，过期 logout 的 finally 不能清除新会话。新增 ApiTransportTest（覆盖晚到401/Cookie隔离、A->B->A、当前401退出、login 401失败显示、请求与下载取消）并复核 NetworkContractTest 全绿通过。 | 单元测试 16 项（ApiTransportTest 6 项 + NetworkContractTest 10 项）全通过，源码静态核对通过；未部署/未真机安装。 |
| 2026-10-30（T03手动金额精度） | B03.13 输入校验：新增 ManualGoalInput.kt 生产解析器 parseManualGoalYuanCents，起始值、新增存取、编辑存取三处统一调用，移除 Workspace 内私有 Double 解析器；普通输入经 trim 最多两位小数，使用 BigDecimal 精确乘 100 并校验 JS 安全整数范围（<= 9007199254740991L），严格拒绝第三位小数（含 1.230，不静默舍入）、非允许零值、负数、指数、NaN/Infinity 及非法格式；单元测试 ManualGoalProgressStateTest 覆盖真实生产解析器合法及异常边界。 | 单元测试用例及源码核验；未部署/未装机。 |
| 2026-10-30（C1核心入口与快捷记账，局部源码更新） | P017–P020/L00.01–04/L01.04/L04.01/L04.06/L04.10–11/A001：底栏调整为首页/账单/＋/计划/我的，AI收进我的→更多工具并保留来源返回；我的分为“记账与计划/更多工具”；首页加本月计划入口并保留预算摘要为非导航；账单默认账户按服务端+认证用户名记忆、只选活跃账户，退款原账户不可用时不静默切换；备注/标签/用途折叠到“更多”，显示状态不修改草稿/显式清除/replay合同；收入表单“记工资”复用 SalarySheet 作为叠加页，返回保留原收入草稿；编辑/退款从详情发起后取消/保存回到该详情。 | `:app:compileDebugKotlin` 与 RecordingDefaults/TransactionEditor/RefundSeed 聚焦 JVM 测试通过；未完成整套 lint/assemble；无设备交互或IME/返回验收，本行仅源码和JVM证据。 |
| 2026-10-26（四账户独立理财计划） | 新增B03.01–06共6项；预算常驻入口+保留底层Dialog页，三手动输入/显式预览与revision保存；shared独立最大余数精确分配、实际开支×5目标、12月假设投入及场景提示；settings单键保存最新快照，无新迁移/自动记账/付费AI。修复创建重放、坏数据拒覆盖/版本天花板，以及原生可观察busy/作用域guard与分析输入快照一致性。 | shared8文件/238项、server38文件/877项（最终maxWorkers2）、lint/typecheck/build通过；Android33套/338项JVM测试、lintDebug/assembleDebug通过，lint0错误/43警告。APK22,347,781字节，SHA256 `E07BAA6D69812B768084F2895F9B3323219DB6A70D654B88183A66C528CFC15C`。限定独立审查两项均闭环。一次高并发回归有两项既有5s超时，单独35项/限并发全量复跑均绿，未改测试超时。未部署/未装机，真机IME/返回/弱网验收待完成；源码结构断言不当作交互证据。 |
| 2026-10-26（AI配置界面重构与模型选择整合） | 保留A038–A062所有契约；布局重构为状态摘要卡、连接与认证就近配置卡、独立模型卡（常用预设收进选择器面板，不混淆为服务端拉取模型）、高级设置折叠卡及固定吸底操作栏；服务端真实启用状态与草稿开关彻底解耦，避免误导；警告条复用t.warning修复暗色主题硬编码。 | Android 29套/299项JVM测试通过（新增7项Helper状态解耦与校验测试），lintDebug 0错误/43警告，assembleDebug通过。新APK 22,258,322字节，SHA256 `E2271B9C096C3B81F2EC5B7357D33E8B04058DBBE9A25538855257519E5AED86`，已通过ADB成功覆盖安装至JER-AN20设备。 |
| 2026-10-26（AI配置模型拉取与搜索选择） | 保留A041/A056/A060；新增POST /ai/models读取已保存连接（禁URL/密钥载荷）、标准路径同源推导、禁重定向/自动重试、2MiB/2000项/200字符限制；Android严格DTO/搜索/选中仅改草稿、显式保存、连接/密钥变化使列表失效，失败不改模型；disabled空model支持首次拉取；保留手填。无新迁移、schema18。 | 后端37文件/825项测试、lint/typecheck/build通过；Android29套/292项JVM测试（新增7项解析/搜索/连接状态测试），lintDebug/assembleDebug通过，lint0错误/43警告。APK22,247,649字节，SHA256 `DE31B38506DD728B4AA4AC1542FC8BEF749CC0A0E1395E191476FB687C9456FC`。独立源码审查无阻断项；异步ownership/互斥缺完整交互自动化，真机搜索/键盘/首次设置流程与真实服务商待验，ADB无设备；未部署。 |
| 2026-10-26（首页按钮、已有标签与统计入口） | 保留L01.04/L01.07/L04.06；删除首页正文底部记账按钮但保留中央＋；总余额下方恢复常驻统计分析卡并复用StatsTab；记账新增可搜索已有标签多选，读取GET /tags活跃账单使用名称，保留手动/旧标签，勾选只更新草稿，独立加载/失败重试不阻塞表单；不改后端或统计口径。 | Android28套/285项JVM测试通过（新增7项生产标签helper测试+3项源码连线检查），lintDebug/assembleDebug通过，lint0错误/43警告；独立限定源码审查无阻断项。APK22,233,469字节，SHA256 `D2A0CD732D1EB528AFD2EB4645F01AAB18606CC3313307BB30F98EB19CB0B7C2`。检测到JER-AN20但本轮未安装/操作账本，入口返回、标签触摸/搜索/重试及小屏/IME待真机验收。 |
| 2026-10-26（备注/标签输入后恢复金额键盘） | 保留L04.03/L04.06；金额卡片点击清除真实文本焦点并隐藏系统输入法，以原有focus回调恢复数字键盘；空金额及紧凑布局均保留切换入口与提示，不重置草稿，不改保存/退款/后端/API或AI配置。 | Android26套/275项JVM测试通过（新增3项源码连线检查，非设备IME测试），lintDebug/assembleDebug通过，lint0错误/43警告；独立限定源码审查无阻断项。APK22,219,528字节，SHA256 `2BBF679B32FBFD81908E0FA61848ED9AF9DF61CC64AB62ABF6D850601161146B`。ADB无连接设备，未安装；反复备注/标签与金额切换、IME动画/组合输入、小屏/横屏/大字待真机验收。 |
| 2026-10-23（整理建议卡片原账单详情） | 保留A105/L03 IDs；分类/标签/备注建议卡片点击复用既有TransactionDetailScreen居中Dialog，完整transactionId读取当前原账单；独立复选框勾选，关闭不重置列表/选择；只读模式隐藏编辑/退款/删除，原账单入口默认行为不变；不改后端、不重新调用AI。 | Android25套/272项JVM测试全通过（新增3项源码连线回归，非Compose触摸测试），lintDebug/assembleDebug通过，lint0错误/43警告；独立限定源码审查无阻断项。APK22,218,895字节，SHA256 `824E184520D50E3D2A40A1BCF2B2F6C32FD48DA65958C2FDF356CA8405F6CC5C`。ADB无连接设备，未真机安装；触摸分流、返回/外部关闭、滚动/勾选保持及大字展示待设备验收。 |
| 2026-10-23（旧账整理超时与显式断点继续） | 保留A105/A106；新任务10笔/批；Migration018将已校验结果/游标放入非行动私有checkpoint，公开卡片与note建议只在全量成功后发布；新增鉴权/CSRF resume POST、独立UUID幂等、attempt/canResume，用户明确继续才再次调用AI，最多3次、24h继续准入；继续前/发布前核对完整源账单及分类等hash，变化拒绝；超时无字段时不再显示“字段未提供”。不修改用户Provider超时/模型配置，不自动付费重试。旧失败任务无断点须新分析。 | server36文件/771项测试、lint/typecheck/build通过；Android24套/269项JVM测试（整理26项）、lintDebug/assembleDebug通过，lint0错误/43警告。APK22,218,130字节，SHA256 `60570A91B87B1B3CD12ADA194DE1DE40D95041343549AA45855A83FEF228BBEE`。独立源代码审查通过限定超时/恢复范围；未接真实Provider、未部署生产、未真机安装本版。 |
| 2026-10-22（AI 智能整理旧账 Android 接入与真实进度修复） | 新增 A105/A106 并修复 Provider 合同与执行进度展示：1. 根因修复 AI_RESPONSE_INVALID：系统提示词独立拆分出 `spending-organization` 特征，强制要求全部 5 个数组（无建议时输出空数组），阻断旧 3 数组提示词与新 5 数组校验器冲突；2. 异步真实进度与优雅停机：POST `/ai/organization-runs` 接入 `background: true` 与 `clientRequestId` 幂等重放，服务停止时经由 Fastify `preClose` 主动 abort 并在进程重启时将未决任务置为 interrupted；3. 进度事件与结构字段诊断：新增 Migration 017（`progress_json`、`client_request_id` 与 `request_hash`），展示真实阶段（准备/分析/校验/生成/就绪）、批次 X/Y、已处理数、建议数及服务端事件时间线，失败展示安全结构字段；4. 手机端 15 分钟有界观察与 GET 恢复：取消假进度与长阻塞，观察中断或超时保留任务编号供手动“继续查看进度”GET 恢复，不自动重发 POST；单次确认应用与条件撤销保持不变。更新 A105/A106、§6.5、§9.3、§10、§11.0–§11.1。 | 本地源码与自动化验证：Android 23 suites / 262 JVM tests 全通过（新增 AssistantOrganizationStateTest 8 项 + AssistantOrganizationProgressTest 11 项 = 19 项整理专项测试全绿），assembleDebug 与 lintDebug 通过（lint 0 errors / 43 warnings / 21 information，warning 为既有图标等基线，不宣称 0 warnings）；debug APK 22,218,137 字节，SHA-256 `1A3AB40094063D1DB9C6BC8F597E5AAAB5DE5E33765B478FF169D10AF42B1E57`；server 35 files / 759 tests、typecheck、lint 通过。未连接真实 Provider、未部署生产、未在物理设备安装，设备/弱网/进程回收/500 笔边界待验。 |
| 2026-10-22（账单页账户切换） | 保留 L02.01–L02.10 ID：月份栏下常驻全部/单账户选择，选择即应用、保留其他已应用条件并回第1页；历史账户元数据独立加载、失败可重试且保留选项，缺失名称不谎称已删；统一不可变查询/代次守卫与翻页纠正，切换不串旧行/条数/错误/结束状态；修正 L02.03/L02.04 搜索/高级面板入口缺失的过时文档，不顺手扩功能；不改生产 API/数据库，不新增余额/收支统计或工资/转账混排。新增 TransactionQueryHelper，main Kotlin 目录增至52。 | 源码及独立 review 闭环；Android 13 suites / 169 JVM tests 全过（新增账户13项，父代理实际解析Gradle XML：0失败/0错误/0跳过）；assembleDebug与lintDebug通过，lint为0 errors / 9 warnings / 18 information，修改的账单页/新helper无lint条目。后端新增3项 API 回归，父代理独立复跑账单62/62、server33文件715/715、typecheck/lint通过；shared7文件187/187由独立测试代理执行通过。当前Debug APK 19,830,293字节，SHA-256 `8c10a75b3d0039c2f177144801150ea8d695b02551afefe4bd1624833a6b8e3f`；详见[任务记录](../../.trellis/tasks/10-22-bill-account-switch/implementation-status.md)。本轮未部署、未装机，设备交互/窄屏/大字/TalkBack/弱网待[验收](../../.trellis/tasks/10-22-bill-account-switch/device-checklist.md)。 |
| 2026-10-17（Android 生产解码器真实 Wire Fixture 验证与 identityKind 修复） | A104 生产解码器修复与真实 Fastify wire JSON fixture 闭环：1. ImportBatchRow identityKind 正式对齐服务端 enum 为 platform_order 与 occurrence，严格拒收 legacy_order 与 unknown（fail-close 抛出 IllegalArgumentException）；2. ImportRowAi.reason 适配服务端 null 值，使用 optCleanString 映射为 ""，防止字面 "null" 字符污染界面；3. note "" 空备注保留、new categoryType 0/1 映射、approvedNewCategoryName 徽章、ReviewSummary.counts 独立 typed counts 及 userExcluded 保持 nullable 行为全部通过真实 wire 数据核验；4. 真实 Fastify wire 34 行 fixture（rows.json）初测因 platform_order 抛错 FAIL，修复后全量 34 行测试 PASS；5. 补充 3 分支解码器单测覆盖 platform_order、occurrence 与 fail-close 拒绝。明确仅验证本地源码与真实本地 route wire fixture，生成 fixture 不等同于真实 Provider/真机；无物理设备安装，无后端部署，真实海量导出 benchmark 缺口保留。 | Android 12 test suites / 156 JVM unit tests 全绿（Gradle XML 真实核验，基线 91 + 批次专项 65 项：NetworkContract 20 + State 45；初测 155 测 1 败 -> 修复后 156 全过），lintDebug 通过（0 errors / 9 warnings / 21 info，明确保留 9 baseline warnings），assembleDebug 编译通过，最新 debug APK 大小 18,473,623 字节，SHA-256 ec2ab9e55f8f78db2b84a5fd5884d413011f7fd5b05733bbebb921ce700deba0 独立核对（明确未在物理设备安装）；前序里程碑构建 153 tests / 19,580,136 字节 0c956aacb1eba013ac064090f407de3253f9b09a20517fcea3fe7ec4017d696e 历史保留；5 份测试 fixture 真实 SHA-256 一致无私密数据；不能断言“真实线上协议已验证”；整体判定 LOCAL VERIFIED / UNTESTED ON DEVICE & LIVE PROVIDER / PENDING FINAL READBACK。 |
| 2026-10-17（Android 批次导入最终边界修复与核对闭环） | A023、A104 及相关边界模型修复闭环：1. ReviewSelectedRow 补充服务端 categoryType 与 approvedNewCategoryName，逐笔展示收支类型与“拟新建”徽章，精确保留空备注 ""；2. parseStrictLong / parseStrictInt 采用 BigDecimal 精确解析，消除 2^63 边界 IEEE-754 溢出，非数字/小数/溢出 fail-close；3. ReviewSummary.counts 独立解析 typed counts，严格隔离 ruleIgnored 与 userExcluded（可空，null 展示为“未提供”，不回退为 0），保留服务端原始财务总计；4. loadFullBatch 接入纯函数 validateAndReduceBatchPages 校验 5 页有界完整性、游标耗尽、循环游标拦截、异常空页拦截与总数一致，混合代次最多重试 2 次且保留用户草稿；5. GET DTO 严格要求非空 viewRevision，移除空白通配回退；明确无新分类自动批准（显式候选/改名弹窗）。 | Android 12 test suites / 153 JVM unit tests 全绿（Gradle XML 真实计数，基线 91 + 批次 62 项：NetworkContract 17 + State 45），lintDebug 通过（0 errors / 9 warnings / 21 info，明确保留 9 warnings 不宣称 0 warnings），assembleDebug 编译通过，debug APK 大小 19,580,136 字节，SHA-256 0c956aacb1eba013ac064090f407de3253f9b09a20517fcea3fe7ec4017d696e 独立核对（未在物理设备安装实测）；合成基准 500 行通过但非真实生产安全证明；未部署生产，未接真实 Provider，源码实施为当前状态但独立 review 仍处于最终读回中，整体判定 LOCAL VERIFIED / UNTESTED ON DEVICE & LIVE PROVIDER / PENDING FINAL READBACK。 |
| 2026-10-17（多文件账单融合导入与AI辅助分类改进 - 前序中间里程碑） | A015–A031、A101–A103 更新，新增 A104：支持1–5个CSV/XLSX文件多选上传（单≤5MiB，总≤8MiB），SAF多文件校验与内存字节处理；全局融合最多500条待核对记录（超500条整批拒绝）；两阶段review-confirm权威审核与原子写入，POST review生成快照与reviewToken，POST confirm校验多文件哈希并单事务原子创建已批准新分类与记账入账；失败文件支持行级移除与就地替换；异步分片AI分析（最多20分片，全成或全败，GET不触发模型）推荐现有叶分类或新分类建议（suggestionId，需显式批准，未批准或未选中不创建），缺失分类提供“其他”新分类建议亦须显式批准，同名候选支持弹窗显式选择与改名新建；全局500条分页（100/页，服务端游标），草稿跨页/筛选保留；未选行点“暂不导入”提供即时反馈并更新统计；只读对比批次行与现有账单；历史单文件200/100导入与卡片取消流程100%兼容隔离；Section 11.0 补齐 11 个批次端点（共 126 个服务端 API），Section 11.1 收录 51 个 main Kotlin 文件，Section 11.2 收录 14 个 route 文件 | 后端 30 files / 684 unit & integration tests 全绿（pnpm test），shared 7 files / 187 tests 全绿，lint/typecheck/build 干净通过；Android 12 test suites / 138 JVM unit tests 全绿（Gradle XML 真实计数，基线 91 + 批次 47 项），lintDebug 通过（0 errors / 9 warnings），assembleDebug 编译通过，debug APK SHA-256 09dc8aa02b9a8aaf7bbb490122fe7afdc6e2ea0233553d11618eb8927ddb85aa 独立核对（明确未在设备安装或实测）；合成基准测试 500 行通过（50ms / +11MiB）；未部署生产，未进行物理设备/真机/真实 Provider/真实导出基准验收，整体判定 LOCAL VERIFIED / UNTESTED ON DEVICE & LIVE PROVIDER，留存缺口移交 parent。 |
| 2026-10-16 / 2026-10-17（滚动药丸 Triple 修复与实机复测） | A014/A011：修复 snapshotFlow 漏测 pending 跃迁导致的药丸常驻缺陷，采用 Triple(newMessagesAvailable, atBottom, isScrollInProgress)；补充 2 项状态流式回归测试；真机实测 off-bottom 触发“有新消息，跳到最新”药丸出现，04terminal 留存药丸（合法尚未真到底），06 自然触底滑动后药丸自动消失（0-pill）；无双泡；未 confirm 记账 | Android 91 项单元测试全绿（Gradle XML 真实计数，基线 89→91 项）；lintDebug (0 error) / assembleDebug 编译通过；新版 APK 5c004350...896e 与已安装 base.apk pull 字节一致；前序 4 组专项 APK d2a37b55... 历史保留；整体判定 PARTIAL / NOT ACCEPTED |
| 2026-10-16（AI流式对话与交互式追问协议v1） | A005/A010–A014/A018–A025/A033/A035：纯文本 POST /generations 流式对话与 POST /cancel 显式停止；streamSse 接收 state/text-delta/message/terminal 事件增量显示成长气泡；单选追问卡（2–6项，>=48dp，点击锁定并支持相同 clientRequestId 重试，409并发保护，不记账）与自由输入；状态徽章区分8种状态；断流转 GET snapshot 核对不盲目重发；历史卡终态优先于快照 pending；A->B->A 与旧 GET 代次隔离；几何边界阅读滚动保护；附件保持 legacy 流程；Section 11.0 补齐 7 个 generation/duplicate/analyse 端点（共 115 个服务端 API），Section 11.1 收录全部 49 个 main Kotlin 文件目录条目 | Android 源码及 87 项本地单元测试通过（测试项数字来自 Gradle Test XML 报告 build/test-results/testDebugUnitTest/*.xml；artifacts/android-stream-check.log 记录 BUILD SUCCESSFUL 全局构建通过但日志文本不含 87 汇总字样）、lintDebug/assembleDebug 编译通过；后端先后经 F1/F2 修复（571 passed）及 tokenizer 空容器/尾随逗号缺陷修复，达到 580 tests/lint/typecheck/build 全通过（artifacts/server-tokenizer-fix-*-20261016-131148.log）；未进行物理设备/真实 Provider/生产部署验收，整体端到端实机验收 pending |
| 2026-10-13（AI功能重设计） | A001/A003/A005/A007/A013/A015–A016/A021/A023–A030/A033/A035/A098：独立会话、紧凑卡、全屏导入/分类/二次核对；200展示/100显式选择/零禁确认；dateLabel、hash匹配、请求代次/上传晚完成隔离；既有Provider/工具合同保留 | 源码与7项新增helper测试；Gradle检查记录见任务ai-assistant-implementation-status.md；无设备/真实AI/生产写入证据 |
| 2026-10-10 | 首次全面盘点当前工作区；建立313个稳定功能ID、全部字段/操作/状态与限制、30个助理工具、API/源码覆盖、缺口和维护流程 | 静态源码核对；没有本轮设备/服务验收 |
| 2026-10-10（本轮 UI 重构） | 4+1 导航（AI 一级、预算/统计二级化）、P022 修复、钛蓝 Token 对齐（#3478F6 系）、首页问候 + Hero + 双快捷卡、账单搜索/筛选收纳 + 日期分组 + 服务端月度摘要、记一笔金额优先 + 分类网格 + 父分类拦截、AI 欢迎 4 快捷、预算/统计返回顶栏；`assembleDebug` / `testDebugUnitTest`（11/11）/ `lintDebug` 通过 | 源码编译验证；设备/深色/小屏/键盘/真实账务流程未验证 |

每次追加一行说明受影响ID、行为改变和核对来源。文档完成不表示现有UI改造已被用户接受，也不结束尚未完成的设备验收。

### 2026-10-13 AI聊天视觉修正 r2

按用户设备截图复核A003/A005/A007/A015–A016/A021/A035：顶部仅保留标题、带图标会话入口及更多菜单；新建、刷新、Provider移入菜单/会话管理。导入聊天卡压缩为摘要和主按钮，详细文件核对在全屏预览中处理。消息区域显式裁切并取消placement动效，避免移动时绘制遮挡；输入区独立Surface边界，附件按钮有强调背景和明确读屏标签。18单元测试、Lint、Debug/Release构建通过；截图所示重叠是否完全解决须r2设备复测，不以构建代替。

### Independent check follow-up
Pending refund statuses (退款中/退款处理中/待退款/退款审核中) remain blocked; mentioning “退款” is not completion evidence. Android category drafts are retained across selection changes within the bounded preview, analysis retry completion cannot close another action/conversation workspace, and failed refresh does not clear the uncertain-analysis gate. The blocked-row count follows hard eligibility rather than a removed generic status label. Independent reruns: shared 176 tests, server 489 tests, package build/lint/typecheck and Android unit/lint/debug build passed; these are mocked/build evidence, not device or live-provider acceptance.

### 2026-10-13 reviewed bill-import implementation
A023/A026–A030/A086/A094/A098 source rechecked for deterministic file facts, configured-provider advisory batches, reasons, refund facts, existing-category IDs and independent editable notes. Added `POST /assistant/actions/:id/analyse` with original digest validation. No feature ID recycled. Shared/server automated tests and Android unit/lint/debug build are separate evidence; no device, live Provider, production deployment or real ledger writes were performed. See `.trellis/tasks/10-13-wechat-import-review/implementation-status.md` for exact checks and remaining manual acceptance. The global audit date is unchanged.

### 2026-10-14 in-workspace duplicate comparison & Ardot UI redesign
A026/A095/A098 and new A101–A103 source rechecked; stable IDs preserved. Added authenticated read-only action/row-scoped duplicate API, bounded pagination/current total/read timestamp, full existing notes and historical reference labels, and in-workspace comparison preserving parent list/drafts. Redesigned import workspace cards and comparison view aligned with Ardot design system: structured card-by-card Key-Value fact comparisons with explicit match indicators ("一致" badges on date, amount, account and type), clear decision actions ("仍然导入此笔" / "排除此笔"), Ardot category tile icons (`FinanceCategoryIcon`), status pill badges and real-time selection overview. Installed and verified on Huawei nova 7 Pro (HarmonyOS 4.2). Global audit date unchanged; exact checks/manual checklist: `.trellis/tasks/10-14-import-duplicate-review/device-status.md`.

### 2026-10-14 full user autonomy over import selection (remove 不可导入 blocking)
A026/A027/A102 source rechecked; stable IDs preserved. Removed artificial "不可导入" blocking restriction: every positive unimported transaction row is eligible for import. In portability-service, explicit selectedIds allows ignored rows (e.g. 资金划转/充值提现) to be imported; UI filter chips updated to "全部", "已选入", "未选", "疑似重复" with real-time counts. Overview card stats updated to "共 N 行预览 · 已选 M/100 · 待选 X · 疑似重复 Y". Shared/server 495 tests, Android unit/lint/debug build passed.

### 2026-10-15 AI conversation correctness follow-up
- A018–A021: deduplicated error rendering; safe code mapping, compact progress, hidden terminal empty progress, readable date/money/type in summaries and operation details. Expanded details retain before/after public reference changes.
- Source/unit/build/lint evidence: server 498 tests and Android 43 tests passed. APK built locally; follow-up APK installation/device rendering and backend rollout are pending approval.
- Actual-device live message after provider configuration repair: one explicitly synthetic draft-only request reached the server and ended with AI_PROVIDER_TIMEOUT after 20,000 ms; no confirmation was performed. This is not successful end-to-end conversation acceptance. New screenshot was black (screen inactive), so no post-change visual acceptance claimed.

### 2026-10-15 installed-build device follow-up
- Follow-up APK installed and byte equality verified. Actual Huawei UI: historical empty complete progress hidden; old timeout shows one safe guidance block.
- New test conversation: hello reply succeeded (~3.0s); draft-only synthetic expense received date clarification (~6.5s), no pending card. End-to-end draft generation remains pending; no assertion that earlier long-conversation timeout is fixed. Before/after manifests changed only assistant conversations/messages; ledger/configuration unchanged.

### 2026-10-16 AI streaming source/build audit
- Stable IDs A005/A010–A014/A018–A025/A033/A035/A093–A100 retain identity; generation routes are source-integrated, not yet deployed/device-accepted. Chat POST with canonical response path is real streaming; Responses/custom/other paths display 完整回复模式, no fake typing. Attachments remain legacy. 以 research/protocol-v1.md 与 spec 为基准进行相容性核对，自动化测试验证基准相容，非形式化证明全空间绝对满足。
- Generation status accepted/running/completed/failed/cancelled/interrupted is separate from ledger confirmation; single question 2–6 options plus free text, click only continues conversation. Server owns question/options and choice superseding.
- Per-line 64KiB/event 128KiB/total 2MiB SSE, strict UTF8 and stateful newline handling; stream subscription disposal cancels blocked HTTP via a separate cancellable owner running blocking reads on the IO thread (`CancellableBlockingFlow`, not a non-blocking parser). Explicit Stop alone requests server cancel (`POST /generations/:genId/cancel`). Seq/offset gaps and EOF without terminal reconcile same generation via `GET /generations/:genId`; no automatic model rerun.
- Cached pending cards cannot override authoritative confirmed/cancelled/expired history. New generation snapshots/events add normalized userMessage/messages/partials with stable IDs.
- Local verification evidence:
  - Android track: 87/87 JVM unit tests passed（数据来自 Gradle Test XML 报告 `build/test-results/testDebugUnitTest/*.xml`；`artifacts/android-stream-check.log` 记录完整执行与 `BUILD SUCCESSFUL`，日志文本中不直接包含 87 数字汇总），`lintDebug` passed (0 errors), `assembleDebug` passed (debug APK compiled, log at `artifacts/android-stream-check.log`)。Section 11.1 覆盖全部 49 个 main Kotlin 文件的目录与条目收录（catalogue / inventory listing coverage），仅对本轮流式改造涉及模块重点审查。
  - Backend track: 最初 F1/F2 修复后达到 571 tests/lint/typecheck/build 通过（`artifacts/server-stream-fixed-*`）；随后针对 tokenizer 空容器 `[]`/`{}` 拒收与对象尾随逗号缺陷进行闭环修复，补充 9 项回归测试及 259 万次特定字符与种子随机生成的有界样本差分检验（验证与 JSON.parse 结构相容性，保留顶层 message 字符串提取及禁止重复键/深度超限等契约特有约束，非所有任意输入 100% 语义等价），最终实现 24 files / 580 tests passed、lint/typecheck/build 均为 0 干净通过（`artifacts/server-tokenizer-fix-*-20261016-131148.log`）。端侧契约 shared 测试经 test-runner 报告 176 项全绿。
  - 后端 review 确认 F1（nested write-tool prepare 超时/取消绑定）、F2（surrogate-safe Unicode 截断）与 tokenizer（空容器与尾随逗号）三缺陷已彻底解决。既有 `assistant-tool-registry.ts` 中 `note`（200 单位）及导入预览投影（160/120/80 单位）原生 `String.slice` 截断边界切分代理对属 pre-existing 非阻断问题，保持现状未修。
  - 迁移排演：独立隔离环境迁移排演通过（19 张旧表 SHA-256 哈希完全一致、新增 2 张流式表、幂等性通过、SQLite integrity ok），基于前序在隔离环境执行记录的 summary 输出与测试脚本 `artifacts/stream-migration-rehearsal/rehearse.mjs`，本轮未重新运行生成新的物理 fresh 日志，明确未在生产数据库 production.db 执行。
- Boundary: All validations reflect local mock/socket/compilation checks; no physical device verification (Huawei nova 7 Pro / HarmonyOS 4.2), no live production upstream provider calls, and no live ledger writes were performed. Caddy streaming buffering, IME interaction, large-font rendering, and long-session network interruptions require separately approved rollout and physical device acceptance.

### 2026-10-16 AI streaming patch deployment & physical device verification (PARTIAL / NOT ACCEPTED)
- Stable IDs A005/A010–A014/A018–A022/A033/A035 source & physical device verified across 4 targeted suites on HUAWEI nova 7 Pro (JER-AN20 / Android 12). Overall verdict is **PARTIAL / NOT ACCEPTED** due to upstream provider failure and interaction defects. No stable ID recycled.
- Deployment & Installed Version Evidence:
  - Backend: Patch #2 deployed online with image `jizhang:api-chained-choice-20261016T083118Z` (`sha256:31bb967e806c556c39c2b257c33c927976d9e568ce2255335b6c9bdb7e9ef11b`), server 24 files / 582 unit and integration tests passed (`npm test`), lint/typecheck clean, production build `BUILD_EXIT=0`. Only single delta `assistant-generation-service.ts` modified (literal NULL for new generation own answer columns, source row atomic consumption preserved). 22/22 live tables unchanged, effective secret values hash identical.
  - Android: 10 test suites / 88 JVM unit tests passed (`testDebugUnitTest`), `lintDebug` 0 errors / 9 warnings, `assembleDebug` passed. Installed base.apk byte hash verified identical to local APK SHA-256 `d2a37b550fb110e9b6174ec2fe874b681f924423e08c7c5be465749e3bb56da8`.
- Physical Device Verified Features (4 Suites):
  1. Chained Clarification Choices (Round 2 PASS): New conversation Choice A -> Question B -> Choice B verified (S1 to answer, S2 to pending-confirmation); own answer columns inserted as NULL, 49 UI tree dumps scanned 0 `ASSISTANT_CHOICE_STALE` errors; old stuck cards (`863a936c`/`ccf489cb`) not touched/repaired and not claimed restored; 16 business tables SHA-256 hash equality confirmed (`50-manifest-after-round2.json`).
  2. Zero-Delta Placeholder & Stop (PASS): In TTFT phase before first token (+1.103s), Stop clicked successfully; server generation `dc9da3e7` cancelled (3 events, 0 deltas, 0 messages), UI showed "已由用户手动停止生成（未执行记账）", 3.5s quiescent period clean with no late cards, table counts unchanged.
  3. Visible Stream Multi-Frame Growth & Deduplication (PASS): Sent 150-word budget advice (`4abe2b48`); captured 35 native screencap frames (~450ms sampling, matching server 36 delta interval, not microsecond aligned); provisional bubble showed progressive text growth from Tip 1 -> Tip 2 -> Tip 3; completed terminal cleanly replaced by single final message with no double bubbles. Note: placeholder title "● 流式生成中 · 结构化草案" is an inherited UI label convention, not financial draft creation. Table counts unchanged.
  4. True ABA Conversation Lifecycle Isolation (Limited PASS / Turn Generation FAILED): Switch to B at +1.68s (earlier than terminal), generation running on server, stayed in B 2.07s, returned to A at +4.91s; B isolated (0 messages, 0 generations); returned to A aligned to same generation (total generations incremented strictly by 1, no duplicate generation created, no double bubbles). BUT generation failed at +20.002s due to upstream provider TTFT 20s timeout (`ASSISTANT_STREAM_BOUNDS` / `AI 响应超时，本次生成已中断。`), no successful answer produced. First ABA run produced 219 chars then failed with `INVALID_ENVELOPE` (`ASSISTANT_STREAM_BOUNDS`), cannot be marked PASS.
- Unresolved Reliability Items (Blocking Full Acceptance):
  1. Upstream LLM Provider timeout (20s TTFT) and envelope parsing fragility (219 chars INVALID_ENVELOPE), causing generation failures without graceful fallback.
  2. Scroll snap interaction defect: every TextDelta unconditional snap causes "有新消息，跳到最新" pill to linger even when card is partially visible.
- Verification Scope Boundary:
  - IME tested for basic visibility; large fonts, weak network / packet drop recovery, and long-session scroll anchoring across multiple turns were not fully verified.
  - Ledger verification: only Round 2 verified 16 business table SHA-256 hash equality; Stop, visible-stream, and ABA suites only verified table row counts (59/2/11), which does not prove full data hash equality. Zero `/confirm` calls or real ledger writes were performed.
  - Deployment and device testing were authorized and executed; git stage/commit and task archive remain unauthorized.

### 2026-10-16 / 2026-10-17 AI 流式滚动药丸修复与实机复测及综合核验 (PARTIAL / NOT ACCEPTED)
- Stable IDs A011/A014 source, unit tests, and real-device verified on HUAWEI nova 7 Pro (JER-AN20 / Android 12). Overall verdict remains **PARTIAL / NOT ACCEPTED** due to recorded upstream LLM provider failures and unverified boundaries (large fonts / weak network / long sessions).
- Version & Deployment Facts:
  - Android Unit & Build: 10 test suites / 91 JVM unit tests passed (`testDebugUnitTest --no-parallel`, verified directly from Gradle Test XML reports in `clients/android/app/build/test-results/testDebugUnitTest/TEST-*.xml`: CancellableBlockingFlow 1, NetworkContract 10, SseParser 12, InputContract 4, ProviderSettingsHelper 5, AssistantConversationHelper 25, AssistantDuplicateState 5, AssistantIdentityCoordinator 6, AssistantImportState 10, AssistantStreamReducer 13; baseline was 89, earlier "88" was a 1-test counting discrepancy, +2 regression tests bring total to 91). `lintDebug` passed (0 errors / 9 warnings), `assembleDebug` passed.
  - Local Debug APK SHA-256: `5c004350fefcfe7b3b284f94a5972fba03c6e28ce23f99b5ad8b7176d083896e`.
  - Installed Device APK: Installed via `adb install -r` (preserving existing app data, firstInstallTime 2026-10-10 kept); pulled `base.apk` verified byte-identical (`cmp` IDENTICAL, SHA-256 `5c004350...896e`). Prior APK SHA-256 `d2a37b550fb110e9b6174ec2fe874b681f924423e08c7c5be465749e3bb56da8` preserved as historical baseline for 4 earlier suites.
  - Backend Server: 24 test files / 582 tests passed, lint/typecheck clean, build `BUILD_EXIT=0`. Online container image `jizhang:api-chained-choice-20261016T083118Z` (`sha256:31bb967e806c556c39c2b257c33c927976d9e568ce2255335b6c9bdb7e9ef11b`) running healthy; 22/22 live database tables unchanged.
- Scroll Pill Indicator Fix & Independent Review:
  - Root cause: `snapshotFlow` in `AssistantTab.kt` previously read only `atBottom` and `isScrollInProgress` into `Pair(atBottom, isScrollInProgress)`. When user remained at bottom and `newMessagesAvailable` transitioned `false -> true`, Compose's internal `distinctUntilChanged` suppressed emission, preventing the `.collect` block from clearing the pill.
  - Minimal fix: `snapshotFlow { Triple(newMessagesAvailable, atBottom, listState.isScrollInProgress) }` reads `newMessagesAvailable` inside the flow, emitting on pending state transition. The helper `shouldClearNewMessagesAvailable` strictly requires `isAtBottom && !isScrollInProgress`.
  - Independent review: PASS. Confirmed no infinite loop, no focus stealing, no text-delta forced scroll, and full drag/history scroll preservation.
- Real-Device Live Retest Evidence (`artifacts/phone-verifier-scroll-live-retest/`):
  - User confirmed recent screenshots: pill appears when off-bottom, auto-dismisses upon reaching natural bottom.
  - Controlled read-only test: sent 300-word budget advice prompt in conversation `091eb632` (single provider call `17a8ea28`, completed, last_seq 100, 96 text-deltas, 19294 bytes). Note: total event payload bytes is wire SSE data size, not prose character count (messages: user 210 + assistant 2152 chars).
  - Terminal & Scroll Timing:
    1. During streaming text delivery, user swiped up to read history; "有新消息，跳到最新" pill appeared on screen (confirmed in Frame 14~21, 1792172463235~1792172465841, matching user screenshots).
    2. In `04-terminal.xml` (captured immediately upon stream termination), pill count = 1 (legitimate because viewport was settled near bottom but not yet at true bottom).
    3. In `06-scroll-bottom.xml` (captured after a natural scroll gesture to true bottom), pill count = 0 (auto-dismissed without clicking pill button). The additional natural swipe occurred a few minutes after terminal (1792172580000 vs 1792172468746 / 01:43:00 vs 01:41:20); we strictly do not claim terminal instantly auto-cleared or claim microsecond timing.
    4. 35 native screencaps sampled at ~400ms intervals (Frame 01 ~ Frame 35, span 1792172458006~1792172471127). Single assistant bubble, zero double bubbles, zero residual pill.
- Provider Reliability Review Findings (`research/provider-reliability-review.md`):
  - Timeout budget: The 20s timeout was confirmed to strictly cover the whole-call budget (headers + full body) in `ai-provider-service.ts` (`callScope` arms one timer, remaining budget passed to body).
  - The two observed failures (219-char `INVALID_ENVELOPE` in ABA test 1, 20s TTFT timeout in ABA retest) remain **FAILED** (not changed to PASS).
  - Without raw upstream provider payload (which is never logged to protect credentials and bounds), envelope parsing failure cannot be asserted as parser fragility.
  - 100% external provider success rate was never a requirement of the frozen contract (`protocol-v1.md`); contract mandates bounded, honest failure reporting without fake fallback.
  - Frozen spec retains failure handling: partial text remains provisional, no automatic retry on failure. We strongly advise against violating the contract by silent fallback, widening timeout, or switching model.
- Ledger Integrity & Red Lines:
  - Zero `/confirm` calls performed; table counts unchanged (59 transactions, 2 transfers, 11 pending actions). Counts unchanged proves row preservation, not full data hash equality.
- Authorization & Status:
  - APK installation authorized and executed; git stage/commit and task archive remain unauthorized.
  - Task status remains `in_progress`. Overall verdict: **核心已列功能专项通过；外部 provider 可靠性有两失败记录 / 大字弱网长对话未全测，完整验收仍 PARTIAL**，待 parent 验收。

### 2026-10-22 品牌、首页真实余额与记账交互优化（LOCAL VERIFIED / UNTESTED ON DEVICE）
- 涉及子任务：[应用名称与六款可切换图标](../../.trellis/tasks/10-22-android-brand-icons/)、[首页真实账户余额与月份简化](../../.trellis/tasks/10-22-android-home-balances/)、[账单卡片与退款记账体验](../../.trellis/tasks/10-22-android-recording-cards/) 及父任务 [品牌与记账体验优化](../../.trellis/tasks/10-22-android-brand-recording/)。
- 交付与改动事实：
  1. **品牌与图标**：应用名称改“Yansuu1记账”（Manifest、strings.xml、登录页）；保留 MainActivity 导出组件以兼容已固定快捷方式，新增 6 个 `activity-alias`（`.LauncherIcon1`..`6`），默认启用第 6 款（橙色背景账本）；`ItemsTab.kt` 的 SettingsFull 中接入 `LauncherIconPicker`，基于 PackageManager 真实组件状态回读与先启后停调度切换；生成 6 组全密度 legacy / round / adaptive XML 图标。
  2. **首页真实余额与月份简化**：移除首页月份下拉选择与 12 个月趋势循环，改为请求当前月 `monthlyTrend(1)`；彻底修复客户端将总余额除以 3 伪造微信/银行卡的 bug，改为消费 `meta.balances()` 返回的服务端权威 `items` 与 `totalBalanceCents`；动态展示全部真实账户（含 0、负债标红、长名截断），提供眼睛隐私开关统一遮蔽总额与各账户金额；余额请求与主模块解耦加载并由代次所有权守卫，主模块失败不阻断余额，余额失败提供独立“重试余额”入口。
  3. **账单详情居中悬浮卡片与退款**：账单详情采用居中精美悬浮卡片 Dialog 呈现（四边留白、圆角白底、顶部标题及关闭✕、中间大图标与分类金额 Hero、紧凑属性列表、底部胶囊编辑/退款/删除按钮），关闭/点击外部/返回均保留来源列表的筛选条件、当前页码与滚动位置；对非退款支出账单新增“记录退款”操作按钮，直接带入原支出 ID 进行退款预填并弹出记账表单；原支出不被修改；提供“删除”二次确认操作。
  4. **金额键盘固定布局与顶部错误**：记账表单重构为固定金额区（32sp 等宽）+ 自定义数字键盘 + 保存区，元数据独立滚动，输入金额与键盘始终可见；输入备注/标签时自动隐藏自定义键盘以避让系统输入法；统一顶底保存按钮为单次同步门控提交器 `TransactionEditorSubmitter` 防快速双击重复记账；表单校验失败与保存错误在顶部浮动提示（默认 4500ms，同文新事件重置，支持手动 ✕ 关闭与无障碍时长延长），保存成功分发刷新令牌就地静默刷新来源列表与首页。
- 本地验证结果：
  - Android 单元测试：**19 test suites / 215 tests 全部通过**（包含原有 169 项 + 本轮新增 46 项专项测试：`LauncherIconControllerTest` 6 项、`DashboardBalancesHelperTest` 10 项、`TransactionEditorHelperTest` 12 项、`TransactionRefundSeedHelperTest` 6 项、`TransactionTopErrorTest` 8 项、`TransactionEditorNetworkContractTest` 3 项，耗时 14s）。
  - Lint 验证：`lintDebug` 结果为 **0 errors**，43 warnings，21 information。无任何新增业务阻断警告。
  - APK 构建：`assembleDebug` 成功构建，产物大小 **22,206,206 字节**，SHA-256 为 `ce2356671fe4d2dda4c55dbcf0b265251369100858f208a8900cdbfc1451486b`。
  - 源码文件覆盖：main Kotlin 源码文件增至 **61 个**，全部收录入 §11.1。
- 验收边界与未执行项：
  - 本轮所有验证均为本地源码、Gradle JVM 自动化测试与离线编译构建；未在真实物理设备（Android / HarmonyOS 4）上安装运行，未连接远程生产服务器，未修改后端代码或数据库，未执行 git commit。
  - 图标在不同桌面启动器（Launcher）上的缓存更新延迟、固定快捷方式迁移、小屏/横屏/大字体下键盘与输入法避让细节、真实屏幕上的触屏手势操作需后续在独立授权的设备验收阶段验证（参见 [设备验收清单](../../.trellis/tasks/10-22-android-brand-recording/device-checklist.md)）。

### 2026-10-27 从已有工资开启四用途

- 新增 B03.09 空态“从已有工资开启”和有周期时“已有工资”入口，分页选择已记录工资，同月多选，服务端返回四项目标后明确确认。规划未开启时引导用户进入设置；不会新增工资或假装真实划拨。
- 未决周期操作按服务地址及用户隔离，单入口使用原请求重放；跨旧工资弹窗/旧对齐入口的 list-then-record 不是原子操作，仍有并发和未知结果恢复缺口，不宣称所有入口完整闭环。后端 null 周期撞已有周期的预览令牌存在已确认缺陷，本入口阻断异常结果，不修改服务端。
- 本地最终 Android 43 suites / 459 tests 通过，lint 0 errors / 43 warnings，assembleDebug 成功；APK 22,866,175 字节，SHA256 `D44ABC2759332274D607D8CEF05711BF59D0C77A3425A3CA92A260577112FA5A`。后端隔离 Vitest 6/6 通过，验证预览零写入、工资/账户/余额不变及同 key 重放。未在真机安装或运行此版，未部署服务端；真机小屏、弱网、过程重启与并发恢复待验。详情见[专项记录](../../.trellis/tasks/10-27-financial-execution-phase1/existing-salary-entry.md)。

### 2026-10-27 理财页点击、滑动与历史查看修复

- B03.08：保持三个固定 composition，只 place 当前页，消除隐藏 Scenario 的手势与无障碍覆盖。旧 APK 真机已复现：Execution 查看不打开，Budget swipe 实际移动 Scenario。
- B03.09：增加刷新进度、禁重复与保留旧数据的失败提示；“历史方案”分页读取已确认周期及追加修订，仅展示冻结决策与明确标注的当前来源核对，不创建/更改周期。旧手动测算仍只保存最新单份；手机原 r3 记录存在。
- B03.11：独立退款读取代次，查看/重试按钮≥48dp，失败不伪报无退款；退款审查内容可滚动，目前只加载首10条，更多退款分页待接入。
- 本地验证：42 suites / 454 tests，0失败/0错误；Lint 0 errors / 43 warnings；assembleDebug 成功。APK 22,795,658 字节，SHA256 `0E14D45AAF134835E3D38F5A89B0E4FF59092DAE701A80E956C83B8C2A143244`。
- 安装：HUAWEI JER-AN20 / Android12，SDK adb install -r Success，未清数据。构建期间手机锁屏，修复后触摸/滑动/历史交互待解锁复验；已有记录的多页、多修订及弱网场景也不能以本地单测冒充真机通过。没有后端部署/生产账务修改。完整证据见[专项记录](../../.trellis/tasks/10-27-financial-execution-phase1/followup-ui-repair.md)。

### 2026-10-27 四用途理财执行系统第一阶段（LOCAL VERIFIED / UNTESTED ON DEVICE）
- 涉及任务：[四用途理财执行系统第一阶段](../../.trellis/tasks/10-27-financial-execution-phase1/) 及父规划 [四用途理财执行系统升级规划](../../.trellis/tasks/10-27-four-purpose-execution-system/)。
- 交付与改动事实：
  1. **统一二级宿主屏幕**：首页与预算入口统一导向“预算与理财规划”二级宿主页（`FinancialHostScreen.kt`），支持三段 Tab（四用途执行、分类信封预算、测算预估），触控区 ≥48dp，常驻 compose 避免切 Tab 丢失草稿，统一 BackHandler 离开守卫；消除 MyTab 外部返回与双标题问题。
  2. **首页模式切换与隔离偏好**：首页预算卡片支持一键平滑切换“分类信封”与“四用途执行”，持久化至 `FinancialPrefs.kt`，按 `serverBaseUrl` + `username` 严格隔离。
  3. **四用途执行工作区**：接入服务端 `/api/v1/financial-planning`，基于 `FinancialExecutionWorkOwner` 代次票据与认证作用域；展示必要开支（50%）与随心消费（10%）实际执行与剩余，成长（25%）与应急（15%）诚实标注文案“未接入实际划拨”，提供分类信封对照参考卡片与差额提示；独立规划设置弹窗（`FinancialConfigSheet.kt`）、分类映射弹窗（`FinancialCategoryMappingSheet.kt`）与退款拆分弹窗（`FinancialRefundSplitDialog.kt`）。
  4. **工资创建幂等与账单用途**：新建工资支持透传 `operationId` 与确认弹窗（`SalaryOperationReplay.kt`、`SalaryFinancialPrompt.kt`）；支出账单增加可选 `financialPurpose`（`essentials`/`joy`/`null` 清除）原子提交与重放（`TransactionEditorHelper.kt`、`TransactionEditSheet.kt`、`TransactionEditorStateHelper.kt`）。
- 本地验证结果：
  1. Android 单元测试：**437 tests 全部通过**（包含原有 348 项 + 本轮新增 89 项理财执行与重放测试：`FinancialExecutionModelsTest` 47 项、`FinancialPrefsTest` 3 项、`FinancialHostAndWorkOwnerTest` 2 项、`SalaryOperationReplayTest` 6 项、`FinancialExecutionSheetStateTest` 16 项、`TransactionEditorPurposeTest` 15 项）。
  2. Lint 验证：`lintDebug` 结果为 **0 errors**，43 warnings。
  3. APK 构建：`assembleDebug` 成功构建，产物大小 **22,716,138 字节**，SHA-256 为 `E9082E85CEB1B11363F7746E57E6BA9B78E5C5AF3FEF23E0EB887368768E801C`。
  4. 后端与共享：`@jizhang/shared` 9 文件 305 测试全通过、typecheck/lint/build 通过；`@jizhang/server` 41 文件 934 测试全通过（`--maxWorkers=2`）、typecheck/lint/build 通过。
- 验收边界与未执行项：
  - 本轮所有验证均为本地源码、Gradle JVM 自动化测试与离线编译构建；未在真实物理设备上安装运行，未连接远程生产服务器，未修改生产数据库，未执行 git commit。
  - 弱网重试、大字/横屏/无障碍焦点流转及生产服务器部署留待后续验收（参见 [阶段验收清单](../../.trellis/tasks/10-27-financial-execution-phase1/device-checklist.md)）。
