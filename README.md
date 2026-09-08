# WhatsApp Sales AI

独立运行的 WhatsApp 智能聊单工作台。通过 WhatsApp Web 二维码登录，可在同一聚合收件箱管理多个号码，读取新消息和 WhatsApp Web 当前可用的历史记录，并使用本地 llama.cpp / Ollama 生成回复；客户图片通过共享货源接口搜图估价，报价必须在管理台审核后才会发送。

## 运行

```powershell
npm install
npm run mysql:dev
npm start
```

打开 `http://127.0.0.1:3010/`，点击右上角 WhatsApp 状态，用手机 WhatsApp 的“已关联设备”扫码。需要管理更多号码时，点击“添加 WhatsApp 账号”，每个二维码用对应手机分别扫描；每个账号拥有独立登录目录，消息会汇总到同一会话列表并显示所属账号。

默认本地模型：

- Provider：`llama.cpp`
- API：`http://127.0.0.1:11435`
- Model：`local`

## 消息流程

1. 每个号码使用独立的 WhatsApp 会话。账号清单和压缩后的扫码登录态保存在 MySQL；`data/auth/` 只是浏览器运行缓存，服务器重建时可从数据库恢复。
2. 登录成功后逐个会话读取历史消息并写入 MySQL。管理台“WhatsApp 历史”设置为 `0` 时，会持续向前加载，直到取完 WhatsApp Web 当前向已关联设备提供的全部记录；也可设置每会话上限。
3. 新文本消息先匹配人工介入规则，再检索近期及相关旧消息，最后交给本地模型。
4. 客户图片下载到 `data/media/`，调用共享货源接口计算成本和建议价。
5. 图片报价只创建 `pending` 审核单；管理台可编辑、驳回，或审核通过后发送。
6. 每个号码绑定一个“智能体”。智能体统一保存客服形象、主营业务、语气、性格、历史风格和补充规则；账号本身只保留 WhatsApp 登录、接管开关和消息队列。
7. 智能体可以同时复用到多个号码，也可以复制成独立版本再调整。修改共享智能体后，所有绑定号码会立即使用新设定；账号的聊天记录和排队状态不会因更换智能体而丢失。
8. 账号完成历史同步后，可点击“读取记录并学习”，从该账号自己发出的历史回复中总结语言、句长、问候、标点和销售推进习惯，并更新当前绑定智能体。

如果本地小模型没有按要求返回结构化的风格摘要，系统会自动根据同一批历史样本的语言占比、平均长度、问候、分行、问句及 emoji 使用情况生成兜底摘要，确保账号不会在没有风格配置的情况下自动回复。

这里的“全部历史”以 WhatsApp Web 已同步到已关联设备的数据为准。如果手机端仍有更早的端到端加密归档但 WhatsApp 没有下发给网页端，任何扫码自动化工具都无法越过这个边界读取。

## MySQL 与上线持久化

- 需要 Node.js `22.5+` 和 MySQL `8.0+`。应用会自动创建数据库和 InnoDB 表；首次启动也会把旧的 `data/state.json` 导入 MySQL，并在 `data/backups/` 留一份迁移前 JSON 备份。
- 联系人、消息、报价、智能体、账号绑定、智能体习惯、回复队列、人工介入/报价节点、学习样本、客户长期记忆、扫码账号和登录会话分别保存在带索引的 InnoDB 业务表中；关联写入使用事务。
- 登录会话使用 `RemoteAuth` 定时压缩写入 `whatsapp_sessions` 表。旧版 `LocalAuth` 目录首次启动会自动导入数据库，因此升级后不需要重新扫码。
- `DATA_DIR` 默认为 `./data`，仅保存媒体文件和浏览器运行缓存。即使缓存目录丢失，扫码账号与登录会话也能从 MySQL 恢复；聊天里的图片/视频原文件仍应将 `media/` 挂载到持久卷或改接对象存储。
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
