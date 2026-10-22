# dsh-plugin-wechat-publisher

> 微信公众号发布插件 — 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 装上「发文」这项能力。

把一篇 Markdown 文章 + 一张封面图，直推到公众号草稿箱。纯 Node.js 实现，**零第三方依赖**，只用微信官方 `/cgi-bin` 接口。

[![topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## 它解决什么问题

Agent 能写文章，但发布这一步一直卡在「人工复制粘贴」上。公众号后台没有开放 Markdown，图片要一张张传，封面还要单独设。

这个插件把这条链路收成一个工具调用：

```
Markdown + 封面图  ──►  wechat_publish_article  ──►  草稿箱
```

模型只要说一句「把这篇文章发到公众号」，剩下的 token 获取、图片上传、正文转 HTML、建草稿，全部在这一个 tool 里完成。

## 安装

```sh
# dsh 侧（pnpm 必需——npm 在这一大坨 @deepseek-ai/dsh-* 依赖上会 OOM）
corepack enable --install-directory ~/.local/bin pnpm

# 从本地目录装进 profile（注意：在插件父目录执行）
dsh plugin --profile web add ./dsh-plugin-wechat-publisher
dsh --profile web
```

看到这一行就说明装载成功：

```
[xiaoziwenjie-code-wechat-publisher] 已就绪 — 工具 wechat_publish_article
```

## 配置

**凭据只从环境变量读，不落盘、不进日志、不出现在工具返回里。**

```sh
export WECHAT_APP_ID=wx______________
export WECHAT_APP_SECRET=______________
```

两件事必须在公众号后台先做好：

1. **IP 白名单** —— 设置与开发 → 基本配置 → IP 白名单，把运行主机的外网出口 IP 加进去。
   这是最常见的失败原因，`errcode=40164` 就是它。
2. **接口权限** —— 订阅号需要认证才有 `draft/add` 和 `freepublish` 权限。

> 本插件会绕过 `HTTP_PROXY` / `HTTPS_PROXY` 调用微信接口。因为微信校验的是真实出口 IP，走代理必然对不上。

## 用法

```jsonc
{
  "markdownPath": "/path/to/article.md",
  "coverPath":    "/path/to/cover.png",
  "title":        "文章标题",
  "author":       "作者名",        // 可选
  "digest":       "摘要，不填取首段",  // 可选
  "mode":         "draft_only"     // 默认，或 full_publish
}
```

返回：

```jsonc
{
  "ok": true,
  "stage": "done",
  "mode": "draft_only",
  "mediaId": "xxxxxxxx",
  "publishId": "",
  "articleUrl": "",
  "title": "文章标题",
  "error": ""
}
```

### 两种模式

| 模式 | 行为 | 什么时候用 |
|---|---|---|
| `draft_only`（默认） | 只调 `draft/add`，落到草稿箱 | **推荐生产默认**。你还能在后台检查、微调、手动发 |
| `full_publish` | 额外调 `freepublish/submit` | 确认能接受 API 发布的差异时 |

⚠️ **`freepublish` 不等于手动点发布。** 它能返回 `publish_id` 和 `article_url`，但文章在公众号首页的实际可见性，和后台手动发布的表现并不总是一致。历史上有发布成功但首页不显示的情况。所以默认走 `draft_only`。

## 失败处理

不抛异常，永远返回结构化结果。`stage` 告诉你卡在哪一步：

| stage | 含义 | 常见原因 |
|---|---|---|
| `token` | 拿 access_token | appid/secret 错（40013）、IP 不在白名单（40164） |
| `cover` | 封面上传 | 图片超 10MB、格式不支持 |
| `content` | 正文转换 | Markdown 文件读不到 |
| `draft` | 建草稿 | 标题过长、正文格式被拒 |
| `publish` | freepublish | **草稿已存好**，只是提交发布失败——去后台手动发即可 |

`full_publish` 在 `publish` 阶段失败时，`mediaId` 仍然有效，文章安全躺在草稿箱里。

## 实现约束

- **正文 HTML 只输出微信不删的标签**：`p/h1-h6/ul/li/blockquote/strong/em/code/a/img`。微信会剥掉 `<style>`，所以样式全部内联交给平台。
- **图片用真格式校验**，不靠扩展名猜 —— 微信按文件头识别，扩展名和实际格式不符会直接拒。
- **封面走 `material/add_material`**（永久素材，返回 `thumb_media_id`），正文图走 `media/uploadimg`（返回临时 URL），两条路径用途不同不能混用。
- **30 秒请求超时**，避免插件卡死拖住整个 session。

## 开发

```sh
pnpm install
npm run build      # tsc → dist/index.js (pure ESM)
npm run typecheck
```

无凭据自检（验证注册和错误分支，不需要真号）：

```sh
node -e "
import('./dist/index.js').then(m => {
  const reg = new Map();
  m.apply({ tools: { register(t){ reg.set(t.name,t); return ()=>{} }, get(n){ return reg.get(n) } } });
  reg.get('wechat_publish_article')
    .execute({ markdownPath:'/tmp/a.md', coverPath:'/tmp/c.png', title:'T' })
    .then(r => console.log(JSON.stringify(r)));
});
"
```

预期输出 `stage: "token"` + `missing WECHAT_APP_ID`。

## 已知坑

1. **`@deepseek-ai/dsh-tools` 的 npm `latest` 是过期的 `0.0.1-rc.1`**，正确版本在 `next` tag。本包已锁 `0.2.1-rc.2`，别手动 `npm i` 覆盖。
2. **pnpm 默认拦截构建脚本**，装 dsh 全家桶时要在 `pnpm-workspace.yaml` 写 `onlyBuiltDependencies`。
3. **8GB 内存机器上 npm 装 dsh 会被静默 OOM 杀掉**，没有任何错误日志，进程直接消失。用 pnpm。

## License

MIT
