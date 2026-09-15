# WhatsApp Sales AI

独立运行的 WhatsApp 智能聊单工作台。通过 WhatsApp Web 二维码登录，可在同一聚合收件箱管理多个号码，读取新消息和 WhatsApp Web 当前可用的历史记录，并使用本地 llama.cpp / Ollama 生成回复；客户图片通过共享货源接口搜图估价，报价必须在管理台审核后才会发送。

## 运行

```powershell
npm install
npm run local:up
```

`local:up` 会依次检查并启动项目 MySQL、本地 Qwen 和工作台。开发时需要持续守护可使用 `npm run local:watch`；它每 15 秒检查一次，任一进程异常退出后会单独拉起。模型启动器会在 CUDA 版本可用时自动将 Qwen 层卸载到 GPU，并使用单推理槽保证完整的 8192 上下文。只想分别启动时仍可使用 `npm run mysql:dev`、`npm run local-ai:qwen35` 和 `npm start`。

打开 `http://127.0.0.1:3010/`，点击右上角 WhatsApp 状态，用手机 WhatsApp 的“已关联设备”扫码。需要管理更多号码时，点击“添加 WhatsApp 账号”，每个二维码用对应手机分别扫描。会话列表按账号分组，通过列表上方的账号选择器切换；搜索和待跟进等筛选仅作用于当前账号，同一个客户在不同账号下也是独立会话。

退出并移除账号、在手机端退出关联设备，或原登录位置换成另一个 WhatsApp 号码时，会清空该账号在当前工作台的会话、报价、回复队列和客户记忆，并阻止旧的后台任务继续写回或发送。原记录先保存到 `data/account-archives/`，独立智能体保留，可手动绑定到新账号。临时网络断开和正常重启不会清空历史。演示会话是单独分组，需要点击预览后查看。

默认本地模型：

- Provider：`llama.cpp`
- API：`http://127.0.0.1:11435`
- Model：`Qwen3.5-9B-Q4_K_M`

## 消息流程

1. 每个号码使用独立的 WhatsApp 会话。账号清单和压缩后的扫码登录态保存在 MySQL；`data/auth/` 只是浏览器运行缓存，服务器重建时可从数据库恢复。
2. 登录成功后逐个会话读取历史消息并写入 MySQL。管理台“WhatsApp 历史”设置为 `0` 时，会持续向前加载，直到取完 WhatsApp Web 当前向已关联设备提供的全部记录；也可设置每会话上限，最多 `50000` 条。
3. 开启账号的智能体接管后，新文本消息自动排队处理；已登录账号同步历史时也能回复，开启自动及断线重连会补入近期未处理的客户消息，无需逐条点击。新文本消息先匹配人工介入规则，再检索近期及相关旧消息，最后交给本地模型；已回复的消息、系统通知、纯 ManosID 标记和人工接管会话不会被补入。
4. 客户图片下载到 `data/media/`，调用共享货源接口计算成本和建议价。
5. 图片报价只创建 `pending` 审核单；管理台可编辑、预览或驳回。同一客户两分钟内连续发送的多张商品图会归为同一报价批次；审核人可勾选其中一件或多件，所选商品每件各占一行并合并成一张报价单，底部显示所选商品总价，未勾选商品继续留待审。报价单使用与 Manos 报价工具相同画布、列宽、黑金版式及官方 Logo；币种模板与 Manos 一致，支持 GBP、EUR、USD、AUD，采购成本、利润率等内部字段不会出现在客户报价单中。
6. 每个号码绑定一个“智能体”。智能体统一保存客服形象、主营业务、语气、性格、历史风格和补充规则；账号本身只保留 WhatsApp 登录、接管开关和消息队列。
7. 智能体可以同时复用到多个号码，也可以复制成独立版本再调整。修改共享智能体后，所有绑定号码会立即使用新设定；账号的聊天记录和排队状态不会因更换智能体而丢失。
8. 账号完成历史同步后，可点击“读取记录并学习”，从该账号自己发出的历史回复中总结语言、句长、问候、标点和销售推进习惯，并更新当前绑定智能体。
9. 每个智能体可以配置自己的“首次接待流程”：最多 12 个文字、图片或视频步骤，严格按排列顺序逐条发送。普通新客招呼与 ManosID 广告询盘共用该流程；复制智能体时会连同完整流程一起复用。每发送成功一步都会保存断点，中途失败将转人工，重试不会重复已完成步骤。
10. 智能体库支持导出、导入 `.wa-agent` 文件。文件会打包人物、业务、语气、历史风格、规则、首次接待流程及其图片/视频；导入始终新建一个未绑定账号的独立智能体，不覆盖现有账号和聊天数据。

风格学习会先依据 WhatsApp 原始消息 ID 校正收发方向，再提取最近最多 300 条去重的本人历史回复，并尽量与前一条客户消息组成“客户问题 → 人工回复”样本。纯数字测试、撤回/媒体占位、ManosID、固定相册文案、收款资料和系统生成的旧 AI 回复会被过滤。整批样本用于统计语言、句长、称呼、问候、标点、问句和 emoji 习惯，再均匀选取最多 40 条代表性摘录交给本地模型；最多 16 组高质量问答会作为该智能体的可复用表达示例，在后续回复时按当前话题检索。风格学习默认等待最多 10 分钟，可通过 `LOCAL_AI_STYLE_TIMEOUT_MS` 调整（1000–1800000 毫秒）。

如果风格学习超时、模型暂时不可用或没有返回完整结构化结果，系统会依据同一批历史样本的统计生成可编辑的“基础风格”，页面明确标注模型分析未完成及原因。真正失败的任务不会再显示 100% 完成；人工添加的规则在重新学习后仍会保留。

本地推理按模型服务地址共用一个队列：客户回复优先于翻译、风格学习及记忆整理；后台任务被打断后会重新排队，排队时间不计入推理超时。回复默认最多等待 5 分钟、翻译 3 分钟、记忆整理 10 分钟，分别通过 `LOCAL_AI_REPLY_TIMEOUT_MS`、`LOCAL_AI_TRANSLATION_TIMEOUT_MS`、`LOCAL_AI_MEMORY_TIMEOUT_MS` 调整。模型状态会显示当前任务与排队数。纯 `ManosID` 广告标记仅保留为消息，不触发问答或翻译；带有实际问题的询盘仍正常处理。

如需 Windows 登录后自动启动并持续守护整套服务，可在确认本机路径和账号无误后手动执行 `npm run local:install-autostart`。该命令会创建当前用户的计划任务；普通开发和测试不需要安装。

这里的“全部历史”以 WhatsApp Web 已同步到已关联设备的数据为准。如果手机端仍有更早的端到端加密归档但 WhatsApp 没有下发给网页端，任何扫码自动化工具都无法越过这个边界读取。

## MySQL 与上线持久化

- 需要 Node.js `22.5+` 和 MySQL `8.0+`。应用会自动创建数据库和 InnoDB 表；首次启动也会把旧的 `data/state.json` 导入 MySQL，并在 `data/backups/` 留一份迁移前 JSON 备份。
- 联系人、消息、报价、智能体、账号绑定、智能体习惯、回复队列、人工介入/报价节点、学习样本、客户长期记忆、扫码账号和登录会话分别保存在带索引的 InnoDB 业务表中；关联写入使用事务。
- 登录会话使用 `RemoteAuth` 定时压缩写入 `whatsapp_sessions` 表。旧版 `LocalAuth` 目录首次启动会自动导入数据库，因此升级后不需要重新扫码。
- `DATA_DIR` 默认为 `./data`，保存媒体文件、浏览器运行缓存和退出账号的本地归档。即使缓存目录丢失，仍在使用的扫码账号与登录会话也能从 MySQL 恢复；聊天里的图片/视频原文件和 `account-archives/` 应挂载到持久卷。
- 生产环境必须设置 `AUTH_SESSION_ENCRYPTION_KEY`（32 字节，64 位十六进制或 base64），防止数据库泄露后登录会话被直接读取。`WHATSAPP_SESSION_BACKUP_INTERVAL_MS` 默认 300000，最小 60000。
- 使用 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE` 和 `MYSQL_CONNECTION_LIMIT` 配置连接池；云数据库需要 TLS 时设置 `MYSQL_SSL=true`。
- 完整性检查：`npm run db:check`。
- 在线一致性备份：`npm run db:backup`，通过 `mysqldump --single-transaction` 写入 `data/backups/`。

生产环境示例：

```env
NODE_ENV=production
HOST=0.0.0.0
PORT=3010
DATA_DIR=/var/lib/whatsapp-sales-ai
MYSQL_HOST=mysql
MYSQL_PORT=3306
MYSQL_USER=whatsapp_sales
MYSQL_PASSWORD=<strong-secret>
MYSQL_DATABASE=whatsapp_sales_ai
AUTH_SESSION_ENCRYPTION_KEY=<32-byte-secret>
```

MySQL 使用 InnoDB 事务和连接池保存业务数据。WhatsApp 自动化进程仍建议每个账号只由一个应用实例持有；多服务器部署时应增加账号级分布式锁和跨实例消息队列。

## 多账号接口

- `POST /api/whatsapp/accounts`：新增账号位并生成独立二维码。
- `POST /api/whatsapp/accounts/:accountId/connect`：重新连接指定账号。
- `POST /api/whatsapp/accounts/:accountId/sync`：只同步指定账号历史。
- `DELETE /api/whatsapp/accounts/:accountId`：退出并移除指定账号。

## 智能体接口

- `GET /api/agents`：读取可复用智能体库。
- `POST /api/agents`：新建空白智能体，或通过 `copyFromAgentId` 复制已有智能体。
- `PUT /api/agents/:agentId`：编辑人物、业务、风格和规则。
- `POST /api/agents/:agentId/welcome-media`：上传首次接待流程使用的图片或视频素材。
- `GET /api/agents/:agentId/export`：下载包含配置和媒体素材的 `.wa-agent` 智能体包。
- `POST /api/agents/import`：以 `application/zip` 上传智能体包，导入为新的独立智能体。
- `POST /api/agents/:agentId/clone`：复制为独立智能体。
- `PUT /api/whatsapp/accounts/:accountId/agent`：为账号更换或复用智能体。
- `DELETE /api/agents/:agentId`：删除未绑定任何账号的智能体。

## 共享货源搜图接口约定

请求：

```json
{
  "image_base64": "...",
  "mime_type": "image/jpeg",
  "source": "whatsapp-web"
}
```

响应支持 `products`、`items`、`matches`、`data` 或 `result` 数组；商品价格字段支持 `cost`、`price`、`unit_price`、`wholesale_price` 或 `salePrice`。

## 风险说明

扫码登录使用的是非官方 WhatsApp Web 自动化库，不受 Meta 官方支持，并存在账号限制风险。建议内部、低频、逐步测试；大规模正式商用应迁移到 Meta WhatsApp Cloud API。
