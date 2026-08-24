import { permissions, type PermRequest } from './stores'
import { oc } from './api'

// Engine permission request shape (v1.18.x):
// { id, sessionID, permission, patterns: string[], metadata: {}, always: string[],
//   tool?: { messageID, callID } }
// metadata varies by tool: bash → { input: { command, ... } }, glob/grep →
// { pattern, path }, webfetch → { url }, mcp → { server }.

export function permDetail(p: PermRequest): string {
  const md = p.metadata ?? {}
  const input = md.input ?? {}
  if (p.permission === 'bash') {
    const cmd = input.command ?? input.script
    if (cmd) return String(cmd).replace(/\s+/g, ' ')
  }
  const candidates = [
    md.url,
    md.path,
    md.pattern && (md.path ? `${md.pattern} (${md.path})` : md.pattern),
    p.permission === 'edit' || p.permission === 'write' ? p.patterns?.[0] : undefined,
    input.filePath,
    input.file_path,
    input.path,
    input.url,
    Array.isArray(p.patterns) && p.patterns.length ? p.patterns.join(', ') : undefined,
    md.server ? `mcp:${md.server}` : undefined,
    Object.keys(input).length ? JSON.stringify(input) : undefined,
    Object.keys(md).length ? JSON.stringify(md) : undefined,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.replace(/\s+/g, ' ').slice(0, 160)
  }
  return ''
}

export function refreshPermissions() {
  return oc
    .permissions()
    .then((raw: any[]) => {
      const list: PermRequest[] = (Array.isArray(raw) ? raw : []).map((p: any) => {
        const req: PermRequest = {
          id: p.id ?? p.requestID,
          sessionID: p.sessionID,
          permission: p.permission ?? p.type,
          patterns: p.patterns ?? [],
          metadata: p.metadata ?? {},
          tool: p.tool,
          type: p.type ?? p.permission,
          title: p.title ?? p.pattern ?? p.path,
          raw: p,
        }
        req.title = permDetail(req)
        return req
      })
      permissions.set(list.filter((x) => x.id))
    })
    .catch(() => permissions.set([]))
}

export async function answerPermission(req: PermRequest, reply: 'once' | 'always' | 'reject') {
  try {
    await oc.replyPermission(req.id, reply)
  } finally {
    refreshPermissions()
  }
}
