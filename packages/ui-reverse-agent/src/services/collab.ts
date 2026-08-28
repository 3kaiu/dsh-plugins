'use strict'
// collab — 协同（设计师/开发者实时评论与批注）

export function createComment({ author, text, path, pos }) {
  return { id: `c-${Date.now().toString(36)}`, author, text, path, pos, at: new Date().toISOString(), resolved: false }
}

export function resolveComment(comments, id) {
  return comments.map(c => c.id === id ? { ...c, resolved: true } : c)
}

export function threadForPath(comments, path) {
  return comments.filter(c => c.path === path)
}
