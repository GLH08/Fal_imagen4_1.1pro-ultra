# Fal AI OpenAI 兼容 Worker

本项目是一个 Cloudflare Worker，它充当 Fal AI 图像生成模型的代理，并提供与 OpenAI API 兼容的接口。这使得客户端应用程序可以像调用 OpenAI 的图像 API 一样与 Fal AI 的模型进行交互。

## 功能特性

-   **OpenAI API 兼容**: 支持 `/v1/images/generations`、`/v1/chat/completions` 和 `/v1/models` 端点。
-   **多模型支持**: 可以配置并调用多个 Fal AI 模型。
    -   `imagen4-preview` (默认)
    -   `Flux 1.1 Pro Ultra`
-   **异步队列处理**: 封装了 Fal AI 的异步任务提交、状态轮询和结果获取逻辑。
-   **聊天式图像生成**: `/v1/chat/completions` 端点可以从用户消息中提取图像描述和尺寸信息。
-   **流式响应**: `/v1/chat/completions` 端点支持流式响应，逐步返回生成过程和结果。
-   **身份验证**:
    -   Worker 自身通过 `Authorization: Bearer YOUR_WORKER_ACCESS_KEY` 进行保护。
    -   Worker 使用 `FAL_API_KEY` 与 Fal AI 服务进行认证。

## 支持的 Fal AI 模型

当前 Worker 配置支持以下模型：

1.  **`imagen4-preview`**: 作为默认模型。
2.  **`Flux 1.1 Pro Ultra`**: 可通过在请求中指定 `model` 参数来选用。

## API 端点

### 1. `GET /v1/models`

列出当前 Worker 支持的 Fal AI 模型。

**响应示例**:

```json
{
  "object": "list",
  "data": [
    {
      "id": "imagen4-preview",
      "object": "model",
      "created": 1677609600,
      "owned_by": "fal-ai",
      "permission": [],
      "root": "imagen4-preview",
      "parent": null
    },
    {
      "id": "Flux 1.1 Pro Ultra",
      "object": "model",
      "created": 1677609600,
      "owned_by": "fal-ai",
      "permission": [],
      "root": "Flux 1.1 Pro Ultra",
      "parent": null
    }
  ]
}
```

### 2. `POST /v1/images/generations`

根据提供的提示词生成图像。

**请求体 (JSON)**:

```json
{
  "prompt": "一只可爱的猫咪",
  "n": 1,
  "size": "1024x1024", // 支持 "1:1", "16:9", "9:16", "4:3", "3:4" 等比例或具体像素值
  "response_format": "url", // "url" 或 "b64_json"
  "model": "imagen4-preview" // 可选, 默认为 "imagen4-preview"。可指定 "Flux 1.1 Pro Ultra"
}
```

**响应示例 (response_format: "url")**:

```json
{
  "created": 1677609600,
  "data": [
    {
      "url": "https://fal.media/..."
    }
  ],
  "model": "imagen4-preview"
}
```

### 3. `POST /v1/chat/completions`

通过类似聊天的接口生成图像。Worker 会从最后一条用户消息中提取提示词和尺寸信息。

**请求体 (JSON)**:

```json
{
  "messages": [
    { "role": "user", "content": "画一只戴着帽子的狗 16:9" }
  ],
  "model": "Flux 1.1 Pro Ultra", // 可选, 默认为 "imagen4-preview"
  "stream": false // 可选, true 则启用流式响应
}
```

**非流式响应示例**:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1677609600,
  "model": "Flux 1.1 Pro Ultra",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Generated image with prompt: \"画一只戴着帽子的狗\" and aspect ratio: 16:9 using Flux 1.1 Pro Ultra\n\n![Generated Image](https://fal.media/...)"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { ... }
}
```

**流式响应**:
响应将是 `text/event-stream` 类型，包含一系列 Server-Sent Events。

## 配置 (环境变量)

在 Cloudflare Worker 的设置中，你需要配置以下环境变量：

-   `WORKER_ACCESS_KEY`: 用于保护 Worker 自身的访问密钥。客户端在请求时需要在 `Authorization` 头中提供 `Bearer YOUR_WORKER_ACCESS_KEY`。
-   `FAL_API_KEY`: 你的 Fal AI API Key，用于 Worker 向 Fal AI 服务发起请求。

## 如何选择模型

在调用 `/v1/images/generations` 或 `/v1/chat/completions` 端点时，可以在请求 JSON 体中包含 `model` 字段来指定要使用的 Fal AI 模型。

-   `"model": "imagen4-preview"`
-   `"model": "Flux 1.1 Pro Ultra"`

如果未提供 `model` 字段，Worker 将默认使用 `imagen4-preview`。

## 部署

1.  将 `index.js` (或你保存代码的文件名) 的内容部署到你的 Cloudflare Worker。
2.  在 Worker 设置中配置上述提到的 `WORKER_ACCESS_KEY` 和 `FAL_API_KEY` 环境变量。

## 使用示例 (cURL)

请将 `YOUR_WORKER_URL` 替换为你的 Cloudflare Worker 的实际 URL，并将 `YOUR_WORKER_ACCESS_KEY` 替换为你设置的访问密钥。

**1. 列出模型**:

```bash
curl -X GET YOUR_WORKER_URL/v1/models \
  -H "Authorization: Bearer YOUR_WORKER_ACCESS_KEY"
```

**2. 使用默认模型 (`imagen4-preview`) 生成图像**:

```bash
curl -X POST YOUR_WORKER_URL/v1/images/generations \
  -H "Authorization: Bearer YOUR_WORKER_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "黄昏时分的热带海滩",
    "n": 1,
    "size": "16:9"
  }'
```

**3. 使用 `Flux 1.1 Pro Ultra` 模型生成图像**:

```bash
curl -X POST YOUR_WORKER_URL/v1/images/generations \
  -H "Authorization: Bearer YOUR_WORKER_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "赛博朋克城市夜景，雨中霓虹闪烁",
    "model": "Flux 1.1 Pro Ultra",
    "n": 1,
    "size": "1024x1024"
  }'
```

**4. 通过聊天接口生成图像 (非流式)**:

```bash
curl -X POST YOUR_WORKER_URL/v1/chat/completions \
  -H "Authorization: Bearer YOUR_WORKER_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "role": "user", "content": "一只宇航员猫咪在月球上 比例:1:1" }
    ],
    "model": "Flux 1.1 Pro Ultra"
  }'
```

**5. 通过聊天接口生成图像 (流式)**:

```bash
curl -X POST YOUR_WORKER_URL/v1/chat/completions \
  -H "Authorization: Bearer YOUR_WORKER_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "role": "user", "content": "日落时分的山脉剪影 16:9" }
    ],
    "model": "imagen4-preview",
    "stream": true
  }' --no-buffer
```
(`--no-buffer` 选项在某些 cURL 版本中用于立即显示流式输出)


希望这份文档对您有所帮助！
