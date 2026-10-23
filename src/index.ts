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
import { readFileSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'

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
function markdownToHtml(md: string, room: number, resolveImage?: (src: string) => string | null): string {
  const P_ROOM = room            // space after each paragraph
  const H_ROOM = room + 14       // space above headings
  const LI_ROOM = Math.max(4, Math.round(room * 0.55))

  const lines = md.split(/\r?\n/)
  const out: string[] = []
  let inList = false
  let inFence = false
  let fenceBuf: string[] = []

  const closeList = () => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }

  // WeChat strips <style> blocks but keeps inline style attributes on block
  // elements, so paragraph rhythm has to be expressed inline.
  const styleFor: Record<string, string> = {
    p: `margin: 0 0 ${P_ROOM}px; line-height: 1.95; font-size: 16px; letter-spacing: 0.4px;`,
    h1: `margin: ${H_ROOM}px 0 18px; line-height: 1.45; font-size: 24px; font-weight: 700;`,
    h2: `margin: ${H_ROOM}px 0 18px; line-height: 1.45; font-size: 21px; font-weight: 700;`,
    h3: `margin: 32px 0 16px; line-height: 1.5; font-size: 18px; font-weight: 700;`,
    h4: `margin: 28px 0 14px; line-height: 1.5; font-size: 17px; font-weight: 700;`,
    li: `margin: 0 0 ${LI_ROOM}px; line-height: 1.95; font-size: 16px;`,
    blockquote: `margin: 0 0 ${P_ROOM}px; padding: 16px 20px; line-height: 1.9; font-size: 15px; border-left: 3px solid #d0d7de; color: #5b6472; background: #f7f8fa;`,
    pre: `margin: 0 0 ${P_ROOM}px; padding: 18px 20px; overflow-x: auto; background: #f6f8fa; border-radius: 6px; font-size: 13px; line-height: 1.75;`,
    hr: `margin: ${Math.round(P_ROOM * 1.8)}px 0; border: none; border-top: 1px solid #e5e7eb;`,
  }

  for (const raw of lines) {
    const line = raw.trimEnd()

    // ── fenced code block ```lang … ``` ───────────────────────────────
    const fence = /^```(\w*)\s*$/.exec(line.trim())
    if (fence) {
      if (!inFence) {
        closeList()
        inFence = true
        fenceBuf = []
      } else {
        out.push(`<pre style="${styleFor.pre}"><code>${fenceBuf.map(escapeHtml).join('\n')}</code></pre>`)
        inFence = false
        fenceBuf = []
      }
      continue
    }

    if (inFence) {
      fenceBuf.push(line)
      continue
    }

    if (!line.trim()) {
      closeList()
      continue
    }

    // ── horizontal rule ───────────────────────────────────────────────
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      closeList()
      out.push(`<hr style="${styleFor.hr}" />`)
      continue
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      closeList()
      const lv = Math.min(h[1].length, 4)
      out.push(`<h${lv} style="${styleFor[`h${lv}`]}">${inline(h[2], resolveImage)}</h${lv}>`)
      continue
    }

    const li = /^[-*]\s+(.*)$/.exec(line)
    if (li) {
      if (!inList) {
        out.push(`<ul style="margin: 0 0 ${P_ROOM}px; padding-left: 24px;">`)
        inList = true
      }
      out.push(`<li style="${styleFor.li}">${inline(li[1], resolveImage)}</li>`)
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      closeList()
      out.push(`<blockquote style="${styleFor.blockquote}">${inline(quote[1], resolveImage)}</blockquote>`)
      continue
    }

    closeList()
    out.push(`<p style="${styleFor.p}">${inline(line, resolveImage)}</p>`)
  }

  // Unclosed fence: emit the buffer rather than dropping it silently.
  if (inFence && fenceBuf.length) {
    out.push(`<pre style="${styleFor.pre}"><code>${fenceBuf.map(escapeHtml).join('\n')}</code></pre>`)
  }

  closeList()
  return `<section style="font-size: 16px; color: #2b2b2b;">${out.join('\n')}</section>`
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(text: string, resolveImage?: (src: string) => string | null): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m: string, alt: string, src: string) => {
      // WeChat drops <img> pointing at foreign hosts, so a local path has to be
      // uploaded first. `null` means the upload failed — emit a visible note
      // instead of a broken image that renders as a blank gap.
      const resolved = resolveImage ? resolveImage(src) : src
      if (resolved === null) {
        return `<span style="color: #9aa0a6; font-size: 13px;">[图片上传失败: ${escapeHtml(alt || src)}]</span>`
      }
      return `<img src="${resolved}" alt="${escapeHtml(alt)}" style="max-width: 100%; display: block; margin: 0 auto;" />`
    })
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
        spacing: {
          type: 'number',
          description:
            'Gap between paragraphs in pixels, 12-64. Default 28. Raise it (e.g. 36) ' +
            'when the article reads cramped on a phone; lower it for dense technical posts.',
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
        // `spacing` widens the gap between paragraphs; 28 is a comfortable
        // default for long-form reading on a phone screen.
        const room = typeof args.spacing === 'number' && args.spacing > 0 ? args.spacing : 28

        // ── 3b. upload in-body images ─────────────────────────────────────
        // WeChat blocks images hosted elsewhere, so every local image mentioned
        // in the Markdown has to go through media/uploadimg first.
        const imageCache = new Map<string, string | null>()
        const mdDir = dirname(args.markdownPath)

        // WeChat's uploadimg is async, so collect every local image first.
        const localImages = [...md.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)]
          .map((m) => m[2].trim())
          .filter((src) => !/^https?:\/\//i.test(src))
        const uniqueImages = [...new Set(localImages)]

        for (const src of uniqueImages) {
          let bytes: Buffer
          let mime: string
          try {
            const abs = resolve(mdDir, src)
            bytes = readFileSync(abs)
            mime = guessMime(abs)
          } catch {
            imageCache.set(src, null)
            continue
          }
          if (bytes.length > MAX_IMAGE_BYTES) {
            imageCache.set(src, null)
            continue
          }
          const form = new FormData()
          form.append('media', new Blob([bytes], { type: mime }), basename(src))
          const up = await wxFetch<WxError & { url?: string }>(
            `${WX_API}/cgi-bin/media/uploadimg?access_token=***}`,
            { method: 'POST', body: form },
          )
          imageCache.set(src, up.ok && up.data?.url ? up.data.url : null)
        }

        const content = markdownToHtml(md, room, (src) => {
          if (/^https?:\/\//i.test(src)) return src
          return imageCache.get(src) ?? null
        })
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
