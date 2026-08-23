import { permissions, type PermRequest } from './stores'
import { oc } from './api'

export async function refreshPermissions() {
  try {
    const raw = await oc.permissions()
    const list: PermRequest[] = (Array.isArray(raw) ? raw : []).map((p: any) => ({
      id: p.id ?? p.requestID,
      sessionID: p.sessionID,
      type: p.type,
      title: p.title ?? p.pattern ?? p.path,
      raw: p,
    }))
    permissions.set(list.filter((x) => x.id))
  } catch {
    permissions.set([])
  }
}

export async function answerPermission(req: PermRequest, reply: 'once' | 'always' | 'reject') {
  try {
    await oc.replyPermission(req.id, reply)
  } finally {
    refreshPermissions()
  }
}
