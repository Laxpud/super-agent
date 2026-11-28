/** 仅在 Studio 主面板挂载样式；色彩跟随宿主明暗主题。 */
export const styles = `
.as-studio {
  --as-inset: clamp(14px, 3.5vw, 36px);
  --as-width: 64rem;
  display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0;
  container: as-studio / inline-size;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
}
.as-studio *, .as-studio { box-sizing: border-box; }
.as-studio :is(h1, h2, h3, h4, p) { margin: 0; }
.as-studio h1 { font-size: 19px; line-height: 1.4; font-weight: 650; }
.as-studio h2 { font-size: 23px; line-height: 1.35; font-weight: 650; }
.as-studio h3 { font-size: 15px; line-height: 1.35; font-weight: 630; }
.as-studio .as-header {
  padding: 14px var(--as-inset) 10px;
  padding-inline-start: max(var(--as-inset), var(--dsh-frame-leading-clearance, 0px));
  padding-block-start: max(14px, var(--dsh-frame-top-clearance, 0px));
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  flex: none;
}
.as-studio .as-brand, .as-studio .as-nav, .as-studio .as-banner {
  max-width: var(--as-width); margin-inline: auto; width: 100%;
}
.as-studio .as-brand, .as-studio .as-nav, .as-studio .as-meta, .as-studio .as-actions, .as-studio .as-pager {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px 9px; min-width: 0;
}
.as-studio .as-brand { justify-content: space-between; }
.as-studio .as-workspace { display: flex; flex: 1; min-height: 0; min-width: 0; }
.as-studio .as-sidebar {
  flex: 0 0 13rem; min-width: 0; padding: 12px; overflow: auto; overscroll-behavior: contain;
  border-inline-end: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
}
.as-studio .as-nav, .as-studio .as-project-nav { display: grid; gap: 5px; align-items: stretch; }
.as-studio .as-nav .as-count { margin-inline-start: auto; }
.as-studio .as-project-nav { border-top: 1px solid var(--dsw-alias-border-l2); margin-top: 12px; padding-top: 12px; }
.as-studio .as-project-nav h3 { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.as-studio .as-project-nav .as-card { padding: 8px; }
.as-studio .as-project-nav-archived summary { cursor: pointer; color: var(--dsw-alias-label-secondary); padding: 5px 3px; }
.as-studio .as-project-nav-archived .as-button { width: 100%; }
.as-studio .as-banner { padding: 8px var(--as-inset) 0; }
.as-studio .as-content { min-height: 0; flex: 1; overflow: auto; overscroll-behavior: contain; }
.as-studio .as-chat, .as-studio .as-detail {
  width: 100%; max-width: calc(var(--as-width) + 2 * var(--as-inset)); margin-inline: auto; padding: 16px var(--as-inset);
  display: flex; flex-direction: column; gap: 12px; min-width: 0;
}
.as-studio .as-chat { height: 100%; min-height: 260px; }
.as-studio .as-view-heading { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 8px 12px; }
.as-studio .as-heading-copy { min-width: 0; flex: 1 1 12rem; overflow-wrap: anywhere; }
.as-studio .as-heading-copy p { margin-top: 4px; color: var(--dsw-alias-label-secondary); }
.as-studio .as-back { align-self: start; }
.as-studio .as-detail { padding-bottom: 32px; align-items: stretch; }
.as-studio .as-detail > .as-button { align-self: start; }
.as-studio .as-timeline {
  min-height: 0; flex: 1; overflow: auto; overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: 12px; scrollbar-gutter: stable; padding: 2px 4px 4px 2px;
}
.as-studio .as-button, .as-studio input, .as-studio select, .as-studio textarea {
  font: inherit; color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1);
  min-height: 30px; padding: 4px 9px; min-width: 0; max-width: 100%;
}
.as-studio .as-button { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; text-align: start; overflow-wrap: anywhere; }
.as-studio .as-nav button { background: transparent; border-color: transparent; }
.as-studio .as-button:not(:disabled):hover, .as-studio .as-button[aria-current='page'] {
  background: var(--dsw-alias-bg-module-platform);
}
.as-studio .as-button.as-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.as-studio .as-button.as-primary:not(:disabled):hover { background: var(--dsw-alias-button-primary-hover); }
.as-studio :is(button, textarea, input, select):disabled { opacity: .55; cursor: not-allowed; }
.as-studio :is(button, textarea, input, select, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px;
}
.as-studio textarea { display: block; padding: 7px 10px; width: 100%; min-height: 52px; resize: vertical; }
.as-studio .as-card, .as-studio .as-message {
  padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1); display: grid; gap: 8px; overflow-wrap: anywhere;
}
.as-studio .as-message { flex: none; width: min(100%, 50rem); }
.as-studio .as-message[data-role='user'] { align-self: end; background: var(--dsw-alias-bg-module-platform); }
.as-studio [data-focused] { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.as-studio .as-message-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
.as-studio .as-meta, .as-studio .as-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.as-studio .as-meta strong, .as-studio .as-meta h3 { color: var(--dsw-alias-label-primary); }
.as-studio .as-pill {
  display: inline-flex; align-items: center; gap: 4px; min-height: 19px; padding: 1px 6px; border-radius: 99px;
  border: 1px solid var(--dsw-alias-border-l2); font-size: 12px; font-weight: 500;
}
.as-studio .as-count { font-variant-numeric: tabular-nums; }
.as-studio .as-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.as-studio [data-tone='warn'], .as-studio .as-warning { color: var(--dsw-alias-state-warn-label); }
.as-studio [data-tone='error'], .as-studio .as-error { color: var(--dsw-alias-state-error-primary); }
.as-studio [data-tone='success'], .as-studio .as-success { color: var(--dsw-alias-label-primary); }
.as-studio [data-tone='success'] .as-dot { background: var(--dsw-alias-state-success-primary); }
.as-studio .as-error, .as-studio .as-warning {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 9px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; overflow-wrap: anywhere;
}
.as-studio .as-end { justify-content: flex-end; }
.as-studio .as-empty { margin: 12px 0; padding: 12px 4px; color: var(--dsw-alias-label-secondary); }
.as-studio .as-topic-root { display: grid; padding-bottom: 12px; gap: 6px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.as-studio .as-quote {
  display: grid; min-width: 0; gap: 2px; padding: 6px 10px; text-align: start; font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border: 0;
  border-inline-start: 3px solid var(--dsw-alias-border-selected); border-radius: 6px; cursor: pointer; overflow-wrap: anywhere;
}
.as-studio .as-quote:hover { background: var(--dsw-alias-bg-overlay); }
.as-studio .as-reference { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; overflow-wrap: anywhere; }
.as-studio .as-reference .as-quote { flex: 1 1 11rem; }
.as-studio .as-artifacts, .as-studio .as-composer, .as-studio .as-fields { display: grid; gap: 7px; min-width: 0; }
.as-studio .as-composer {
  flex: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 9px;
  background: var(--dsw-alias-bg-layer-1);
}
.as-studio .as-composer textarea { max-height: 22vh; }
.as-studio .as-artifact { padding: 7px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; }
.as-studio .as-artifact summary { cursor: pointer; }
.as-studio .as-artifact[open] .as-message-text { margin: 6px 0; max-height: 22rem; overflow: auto; }
.as-studio .as-search { display: flex; gap: 8px; }
.as-studio .as-search input { flex: 1; }
.as-studio .as-record-list, .as-studio .as-event-list { padding: 0; margin: 0; list-style: none; display: grid; gap: 7px; }
.as-studio .as-record-row {
  width: 100%; padding: 8px 10px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; text-align: start; font: inherit; cursor: pointer;
  display: grid; gap: 4px; overflow-wrap: anywhere;
}
.as-studio .as-record-row:hover, .as-studio .as-task-row[aria-pressed='true'] { background: var(--dsw-alias-bg-module-platform); }
.as-studio .as-task-row[aria-pressed='true'] { border-color: var(--dsw-alias-border-selected); }
.as-studio .as-task-filters { display: flex; flex-wrap: wrap; gap: 8px; }
.as-studio .as-task-filters label { flex: 0 1 14rem; }
.as-studio .as-tasks-layout { display: grid; gap: 12px; align-items: start; }
.as-studio .as-tasks-layout[data-selected] { grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); }
.as-studio .as-task-list { display: grid; min-width: 0; gap: 8px; }
.as-studio .as-task-row-title { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 6px 9px; }
.as-studio .as-task-snippet { color: var(--dsw-alias-label-secondary); font-size: 13px; }
.as-studio .as-facts {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
  margin: 0; gap: 8px 12px; overflow-wrap: anywhere;
}
.as-studio .as-facts dt { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.as-studio .as-facts dd { margin: 2px 0 0; min-width: 0; }
.as-studio .as-task-section { border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 8px; }
.as-studio .as-task-section h4 { font-size: 14px; }
.as-studio .as-task-files { margin: 0; padding-inline-start: 20px; }
.as-studio .as-check-output {
  margin: 4px 0 0; padding: 6px 8px; background: var(--dsw-alias-bg-layer-2); border-radius: 6px;
}
.as-studio .as-project-bar {
  display: grid; gap: 8px; background: var(--dsw-alias-bg-layer-1); flex: none;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 9px 12px;
}
.as-studio .as-project-bar-top { display: flex; align-items: start; flex-wrap: wrap; gap: 8px 12px; }
.as-studio .as-project-facts { flex: 1 1 20rem; font-size: 13px; }
.as-studio .as-project-facts .as-message-text { max-height: 5rem; overflow: auto; }
.as-studio .as-project-drawer {
  max-height: min(38vh, 24rem); overflow: auto; overscroll-behavior: contain;
  border-top: 1px solid var(--dsw-alias-border-l2); padding: 10px 2px 2px;
}
.as-studio .as-project-actions { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2); }
.as-studio .as-model-fields { border: 1px solid var(--dsw-alias-border-l2); padding: 6px 10px 10px; border-radius: 8px; min-width: 0; }
.as-studio .as-model-fields legend { font-weight: 630; }
.as-studio .as-model-grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr)); }
.as-studio .as-model-grid label { display: grid; gap: 4px; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.as-studio .as-model-grid select { width: 100%; font-size: 13px; }
.as-studio .as-feishu-state { display: inline-flex; align-items: center; gap: 5px; }
.as-studio .as-settings-nav { display: flex; flex-wrap: wrap; gap: 6px; border-bottom: 1px solid var(--dsw-alias-border-l2); padding-bottom: 10px; }
.as-studio .as-settings-nav [aria-current='page'] { border-color: var(--dsw-alias-border-selected); font-weight: 650; }
.as-studio .as-config-view { display: grid; gap: 12px; min-width: 0; }
.as-studio .as-config-view[hidden] { display: none; }
.as-studio .as-setting-panel { padding: 0; border: 0; margin: 0; min-width: 0; }
.as-studio .as-setting-field { display: grid; gap: 4px; min-width: 0; align-content: start; }
.as-studio .as-setting-field select { width: 100%; }
.as-studio .as-setting-row { display: grid; gap: 4px; min-width: 0; }
.as-studio .as-settings-code { display: block; padding: 7px 9px; background: var(--dsw-alias-bg-layer-2); border-radius: 7px; overflow-wrap: anywhere; }
.as-studio .as-settings a { color: var(--dsw-alias-label-primary); text-decoration: underline; text-underline-offset: 2px; }
.as-studio .as-settings-dialog {
  width: min(90%, 34rem); max-height: 85vh; padding: 16px; overflow: auto; margin: auto;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
}
.as-studio .as-settings-dialog::backdrop { background: var(--dsw-alias-bg-overlay); }
.as-studio .as-settings-dialog form { display: grid; gap: 12px; }
.as-studio .as-settings-changes { margin-block: 0; padding-inline-start: 22px; }
.as-studio .as-visually-hidden { position: absolute; clip-path: inset(50%); width: 1px; height: 1px; overflow: hidden; white-space: nowrap; }
@container as-studio (max-width: 58rem) {
  .as-studio .as-tasks-layout[data-selected] { grid-template-columns: minmax(0, 1fr); }
  .as-studio .as-task-detail { grid-row: 1; }
}
@container as-studio (max-width: 42rem) {
  .as-studio .as-workspace { flex-direction: column; }
  .as-studio .as-sidebar {
    flex: none; max-height: min(40%, 20rem); border-inline-end: 0; border-bottom: 1px solid var(--dsw-alias-border-l2);
    padding: 8px var(--as-inset);
  }
  .as-studio .as-nav { display: flex; }
  .as-studio .as-project-nav { grid-template-columns: repeat(2, minmax(0, 1fr)); padding-top: 6px; margin-top: 6px; }
  .as-studio .as-project-nav > :is(h3, div, details) { grid-column: 1 / -1; }
}
@media (pointer: coarse) {
  .as-studio :is(button, input, select, summary) { min-height: 44px; }
  .as-studio .as-artifact summary { padding-block: 10px; }
}
`
