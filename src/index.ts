// dsh-plugin-wechat-publisher — the `wechat_publish_article` tool plugin.
//
// Publishes a Markdown article + cover image to a WeChat Official Account (公众号)
// draft box via the official 微信公众平台 API — no third-party dependencies.
//
// API surface used (all official /cgi-bin endpoints):
//   GET  /cgi-bin/token                      — access_token
//   POST /cgi-bin/material/add_material       — cover image → permanent thumb_media_id
//   POST /cgi-bin/media/uploadimg             — in-body images → hosted URL
//   POST /cgi-bin/draft/add                   — create draft → media_id
//   POST /cgi-bin/freepublish/submit          — optional: submit draft for publication
//
// ── Design notes / 设计说明 ─────────────────────────────────────────────────
// 1. Credentials are read from the environment ONLY (WECHAT_APP_ID / WECHAT_APP_SECRET).
//    They are never written to disk, never returned in tool output, never logged.
// 2. Proxies are bypassed for api.weixin.qq.com: the WeChat IP allowlist checks the
//    real egress IP, and a proxy silently breaks the token exchange.
// 3. `draft_only` is the DEFAULT publish mode. `freepublish_submit` returns success
//    while behaving differently from manual backend publishing, so it is opt-in.
// 4. Every failure returns a structured error with the WeChat errcode/errmsg instead
//    of throwing, so the agent can decide what to retry.
//
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

export const name = 'xiaoziwenjie-code-wechat-publisher'

export const inject = ['tools']

const WX_API = 'https://api.weixin.qq.com'

// WeChat's permanent-material limit for a single image upload.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

interface WxError {
  errcode?: number
  errmsg?: string
}

/** Call the WeChat API, bypassing any proxy configuration. */
async function wxFetch<T extends WxError>(
  url: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; data: T | null; error?: string }> {
  try {
    const res = await fetch(url, {
      ...init,
      // `dispatcher: undefined` is not enough — Node honours HTTP(S)_PROXY via
      // undici's default agent, so we disable it explicitly here.
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    let data: T
    try {
      data = JSON.parse(text) as T
    } catch {
      return { ok: false, data: null, error: `non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}` }
    }
    if (data.errcode && data.errcode !== 0) {
      return { ok: false, data, error: `wechat errcode=${data.errcode} errmsg=${data.errmsg ?? ''}` }
    }
    return { ok: true, data }
  } catch (err) {
    return { ok: false, data: null, error: (err as Error).message }
  }
}

function guessMime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    default:
      return 'image/jpeg'
  }
}

/**
 * Minimal Markdown → WeChat-compatible HTML.
 * Deliberately small: WeChat strips <style> blocks, so only inline-safe tags survive.
 */
function markdownToHtml(md: string): string {
  const lines = md.split(/\r?\n/)
  const out: string[] = []
  let inList = false

  const closeList = () => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      closeList()
      continue
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      closeList()
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`)
      continue
    }

    const li = /^[-*]\s+(.*)$/.exec(line)
    if (li) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${inline(li[1])}</li>`)
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      closeList()
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`)
      continue
    }

    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }

  closeList()
  return out.join('\n')
}

function inline(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
}

export function apply(ctx: Context) {
  ctx.tools.register(
    defineTool({
      name: 'wechat_publish_article',
      description:
        'Publish a Markdown article with a cover image to a WeChat Official Account (公众号) draft box. ' +
        'Reads WECHAT_APP_ID and WECHAT_APP_SECRET from the environment. ' +
        'Default mode is draft_only (saves to 草稿箱); use mode=full_publish to also submit via freepublish.',

      parameters: {
        markdownPath: {
          type: 'string',
          required: true,
          description: 'Absolute path to the article Markdown file.',
        },
        coverPath: {
          type: 'string',
          required: true,
          description: 'Absolute path to the cover image (jpg/png, <=10MB).',
        },
        title: {
          type: 'string',
          required: true,
          description: 'Article title shown in the 公众号 list.',
        },
        author: {
          type: 'string',
          description: 'Author name displayed under the title. Optional.',
        },
        digest: {
          type: 'string',
          description: 'Summary shown in share cards (<=120 chars). Defaults to the first paragraph.',
        },
        mode: {
          type: 'string',
          description: "'draft_only' (default) or 'full_publish' (also submit for publication).",
        },
      },

      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', required: true, description: 'Whether the whole operation succeeded.' },
            stage: {
              type: 'string',
              required: true,
              description: 'Last stage reached: token | cover | content | draft | publish | done.',
            },
            mode: { type: 'string', required: true, description: 'Publish mode actually used.' },
            mediaId: { type: 'string', required: true, description: 'Draft media_id (empty string if not reached).' },
            publishId: { type: 'string', required: true, description: 'freepublish id (only for full_publish).' },
            articleUrl: { type: 'string', required: true, description: 'Article URL if the platform returned one.' },
            title: { type: 'string', required: true, description: 'Title that was submitted.' },
            error: { type: 'string', required: true, description: 'Error detail (empty string on success).' },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.ok
              ? `✅ 已提交到草稿箱\n标题: ${value.title}\nmedia_id: ${value.mediaId}` +
                (value.publishId ? `\npublish_id: ${value.publishId}` : '') +
                (value.articleUrl ? `\n链接: ${value.articleUrl}` : '')
              : `❌ 失败于阶段 [${value.stage}]\n${value.error}`,
          },
        ],
      },

      async execute(args) {
        const mode = args.mode === 'full_publish' ? 'full_publish' : 'draft_only'
        const result = {
          ok: false,
          stage: 'token',
          mode,
          mediaId: '',
          publishId: '',
          articleUrl: '',
          title: args.title,
          error: '',
        }

        // ── 0. credentials ────────────────────────────────────────────────
        const appId = process.env.WECHAT_APP_ID
        const appSecret = process.env.WECHAT_APP_SECRET
        if (!appId || !appSecret) {
          result.error =
            'missing WECHAT_APP_ID / WECHAT_APP_SECRET in the environment. ' +
            'Also confirm this host egress IP is in the 公众号 IP allowlist.'
          return result
        }

        // ── 1. access_token ───────────────────────────────────────────────
        const tokenRes = await wxFetch<WxError & { access_token?: string }>(
          `${WX_API}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`,
        )
        const token = tokenRes.data?.access_token
        if (!tokenRes.ok || !token) {
          result.error = `access_token failed: ${tokenRes.error ?? 'no access_token in response'}`
          return result
        }
        result.stage = 'cover'

        // ── 2. cover → permanent thumb_media_id ───────────────────────────
        let coverStat
        try {
          coverStat = await stat(args.coverPath)
        } catch {
          result.error = `cover not found: ${args.coverPath}`
          return result
        }
        if (coverStat.size > MAX_IMAGE_BYTES) {
          result.error = `cover is ${(coverStat.size / 1024 / 1024).toFixed(1)}MB, WeChat limit is 10MB`
          return result
        }

        const coverBytes = await readFile(args.coverPath)
        const coverForm = new FormData()
        coverForm.append('media', new Blob([coverBytes], { type: guessMime(args.coverPath) }), basename(args.coverPath))
        const coverRes = await wxFetch<WxError & { media_id?: string }>(
          `${WX_API}/cgi-bin/material/add_material?access_token=${token}&type=image`,
          { method: 'POST', body: coverForm },
        )
        const thumbMediaId = coverRes.data?.media_id
        if (!coverRes.ok || !thumbMediaId) {
          result.error = `cover upload failed: ${coverRes.error ?? 'no media_id'}`
          return result
        }
        result.stage = 'content'

        // ── 3. markdown → html ────────────────────────────────────────────
        let md: string
        try {
          md = await readFile(args.markdownPath, 'utf-8')
        } catch {
          result.error = `markdown not found: ${args.markdownPath}`
          return result
        }
        // Strip a leading YAML frontmatter block if present.
        md = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
        const content = markdownToHtml(md)
        const digest =
          args.digest ?? (md.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) ?? '').slice(0, 120)
        result.stage = 'draft'

        // ── 4. draft/add ──────────────────────────────────────────────────
        const draftBody = {
          articles: [
            {
              title: args.title,
              author: args.author ?? '',
              digest,
              content,
              thumb_media_id: thumbMediaId,
              need_open_comment: 0,
              only_fans_can_comment: 0,
            },
          ],
        }
        const draftRes = await wxFetch<WxError & { media_id?: string }>(
          `${WX_API}/cgi-bin/draft/add?access_token=${token}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(draftBody),
          },
        )
        const mediaId = draftRes.data?.media_id
        if (!draftRes.ok || !mediaId) {
          result.error = `draft/add failed: ${draftRes.error ?? 'no media_id'}`
          return result
        }
        result.mediaId = mediaId
        result.stage = 'done'
        result.ok = true

        // ── 5. optional freepublish ───────────────────────────────────────
        if (mode === 'full_publish') {
          result.stage = 'publish'
          result.ok = false
          const pubRes = await wxFetch<WxError & { publish_id?: string; article_url?: string }>(
            `${WX_API}/cgi-bin/freepublish/submit?access_token=${token}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ media_id: mediaId }),
            },
          )
          if (!pubRes.ok) {
            result.error =
              `draft saved (media_id=${mediaId}) but freepublish failed: ${pubRes.error ?? 'unknown'}. ` +
              'The article is safe in the 草稿箱 — publish it manually from the MP backend.'
            return result
          }
          result.publishId = pubRes.data?.publish_id ?? ''
          result.articleUrl = pubRes.data?.article_url ?? ''
          result.stage = 'done'
          result.ok = true
        }

        return result
      },
    }),
  )
}
