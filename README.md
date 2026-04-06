# YZMM Status - Workers API

Cloudflare Worker API，处理数据请求和缓存。

## 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/websites` | GET | 获取网站状态 |
| `/api/server` | GET | 获取服务器资源 |
| `/api/minecraft` | GET | 获取 MC 服务器状态 |
| `/api/update` | POST | Agent 推送数据 |

## KV 数据结构

| Key | Value | 说明 |
|-----|-------|------|
| `website:0` | `{ online, latency, status }` | 第一个网站状态 |
| `website:1` | `{ online, latency, status }` | 第二个网站状态 |
| `mc:host:port` | `{ online, players, version, motd, playerList }` | MC 服务器状态 |
| `server` | `{ data: { cpu, memory, uptime, load }, timestamp }` | Agent 推送的服务器资源 |

## 缓存时间

| 数据 | TTL |
|------|-----|
| 网站状态 | 10 秒 |
| MC 服务器 | 20 秒 |
| 服务器资源 | 60 秒 |

## 部署

```bash
npm install
npm run deploy
```

## 配置

**wrangler.toml**:
```toml
name = "rishus-status"
main = "index.js"
compatibility_date = "2026-4-6"

[[kv_namespaces]]
binding = "SERVER_STATUS"
id = "your-kv-id"
```

**Cloudflare Dashboard → Settings → Variables**:

| 变量名 | 类型 | 示例 |
|--------|------|------|
| `MC_SERVERS` | Text | `[{"name":"Finaless","host":"mc.yz-mm.top","port":25565,"infoUrl":"https://..."}]` |
| `WEBSITES` | Text | `[{"name":"一只铭铭的小站","url":"https://yz-mm.top"}]` |
| `UPDATE_TOKEN` | Secret | `your-secure-token` |
| `UAPI_KEY` | Secret | `your-uapi-key` |

## License

MIT
