# ui-reverse Agent Preset

- id: ui-reverse
- name: UI Reverse Engineering Agent
- description: 1:1 视觉还原 Agent — 参考 UI → 浏览器闭环迭代至阈值
- tools:
  - dsh-layout-infer: infer_layout, annotate_layout, clean_layout, classify_design, page_layout_tree, compare_layouts
  - dsh-ui-reverse-agent: reference_ingest, neutral_ingest, browser_start, browser_viewport, browser_navigate, browser_screenshot, browser_dom_dump, browser_state_trigger, browser_console, browser_stop, compare_geometry, compare_typography, compare_palette, compare_screenshots, score_report, fanout_evaluate, verify_neutral, viewport_matrix, token_map, check_design_constraints, check_a11y, recovery_plan, ci_report, check_dsl_security, git_rollback_point, estimate_cost, capture_feedback, critique_design, generate_design_system, plan_experts, generate_handoff, anti_hack_scan, state_read, state_update
  - host: read, write, edit, glob, grep, bash
- prompt: src/agent/prompt.ts (PROMPT_TEMPLATE)
- config: src/config.ts (COMPLETE_THRESHOLD 0.96 等)
- artifacts: .ui-reverse/
