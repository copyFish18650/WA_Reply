# WhatsApp Sales AI

独立运行的 WhatsApp 智能聊单工作台。通过 WhatsApp Web 二维码登录，可在同一聚合收件箱管理多个号码，读取新消息和 WhatsApp Web 当前可用的历史记录，并使用本地 llama.cpp / Ollama 生成回复；客户图片通过共享货源接口搜图估价，报价必须在管理台审核后才会发送。

## 运行

```powershell
npm install
npm start
```

打开 `http://127.0.0.1:3010/`，点击右上角 WhatsApp 状态，用手机 WhatsApp 的“已关联设备”扫码。需要管理更多号码时，点击“添加 WhatsApp 账号”，每个二维码用对应手机分别扫描；每个账号拥有独立登录目录，消息会汇总到同一会话列表并显示所属账号。

默认本地模型：

- Provider：`llama.cpp`
- API：`http://127.0.0.1:11435`
- Model：`local`

## 消息流程

1. 每个号码使用独立的 `LocalAuth` 会话，WhatsApp Web 登录状态保存在 `data/auth/`。
2. 登录成功后逐个会话读取历史消息，保存在 `data/state.json`。管理台“WhatsApp 历史”设置为 `0` 时，会持续向前加载，直到取完 WhatsApp Web 当前向已关联设备提供的全部记录；也可设置每会话上限。
3. 新文本消息先匹配人工介入规则，再检索近期及相关旧消息，最后交给本地模型。
4. 客户图片下载到 `data/media/`，调用共享货源接口计算成本和建议价。
5. 图片报价只创建 `pending` 审核单；管理台可编辑、驳回，或审核通过后发送。
6. 每个号码绑定一个“智能体”。智能体统一保存客服形象、主营业务、语气、性格、历史风格和补充规则；账号本身只保留 WhatsApp 登录、接管开关和消息队列。
7. 智能体可以同时复用到多个号码，也可以复制成独立版本再调整。修改共享智能体后，所有绑定号码会立即使用新设定；账号的聊天记录和排队状态不会因更换智能体而丢失。
8. 账号完成历史同步后，可点击“读取记录并学习”，从该账号自己发出的历史回复中总结语言、句长、问候、标点和销售推进习惯，并更新当前绑定智能体。

如果本地小模型没有按要求返回结构化的风格摘要，系统会自动根据同一批历史样本的语言占比、平均长度、问候、分行、问句及 emoji 使用情况生成兜底摘要，确保账号不会在没有风格配置的情况下自动回复。

这里的“全部历史”以 WhatsApp Web 已同步到已关联设备的数据为准。如果手机端仍有更早的端到端加密归档但 WhatsApp 没有下发给网页端，任何扫码自动化工具都无法越过这个边界读取。

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
