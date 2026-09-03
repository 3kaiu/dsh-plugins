'use strict'
// collab — 协同（设计师/开发者实时评论与批注）

export function createComment({ author, text, path, pos }: any) {
  return { id: `c-${Date.now().toString(36)}`, author, text, path, pos, at: new Date().toISOString(), resolved: false }
}

export function resolveComment(comments: any, id: any) {
  return comments.map((c: any) => c.id === id ? { ...c, resolved: true } : c)
}

export function threadForPath(comments: any, path: any) {
  return comments.filter((c: any) => c.path === path)
}
