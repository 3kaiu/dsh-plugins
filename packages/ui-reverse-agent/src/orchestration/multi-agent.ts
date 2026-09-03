'use strict'
// multi-agent — layout/style/content 三专家分解与合并（Phase4-5 的并行专家）
// 输入：mismatches 列表，输出：按专家分组 + 合并策略

export const EXPERTS = {
  layout: { name: 'layout', props: ['x','y','width','height','gap','padding','margin'], priority: 'P0/P1' },
  style: { name: 'style', props: ['color','backgroundColor','borderColor','borderRadius','shadow','opacity'], priority: 'P2' },
  content: { name: 'content', props: ['text','fontFamily','fontSize','fontWeight','src','alt'], priority: 'P1/P2' },
}

export function classifyByExpert(mismatches: any) {
  const byExpert = { layout: [], style: [], content: [], unknown: [] }
  for (const m of mismatches) {
    const prop = m.prop || m.property || ''
    let assigned = false
    for (const [key, exp] of Object.entries(EXPERTS)) {
      if (exp.props.includes(prop)) { (byExpert as any)[key].push(m); assigned = true; break }
    }
    if (!assigned) (byExpert as any).unknown.push(m)
  }
  return byExpert
}

export function planParallelExperts(mismatches: any, { maxPerExpert = 2 }: Record<string, any> = {}) {
  const byExpert = classifyByExpert(mismatches)
  const plans = []
  for (const [expert, list] of Object.entries(byExpert)) {
    if (expert === 'unknown' || list.length === 0) continue
    // 每专家取前 N 个（按 delta 降序，已在 compare 中排序）
    const top = list.slice(0, maxPerExpert)
    plans.push({ expert, count: top.length, mismatches: top, parallelGroup: expert })
  }
  return { byExpert, plans, totalGroups: plans.length, canParallel: plans.length > 1 }
}

export function mergeExpertResults(results: any) {
  // results: [{expert, score, changes}]
  const totalScore = results.reduce((a: any, r: any) => a + (r.score?.total ?? 0), 0) / (results.length || 1)
  const allChanges = results.flatMap((r: any) => r.changes || [])
  const byExpert: any = {}
  for (const r of results) (byExpert as any)[r.expert] = r
  return { totalScore: Math.round(totalScore*1000)/1000, byExpert, allChanges, summary: `${results.length} experts merged S ${Math.round(totalScore*1000)/1000}` }
}
