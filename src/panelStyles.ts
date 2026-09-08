export const PANEL_STYLES = `
  :root {
    color-scheme: light;
    font-family: system-ui, sans-serif;
    --panel-text: #162c35;
    --panel-bg: #f3f7f7;
    --panel-surface: #ffffff;
    --panel-border: #d7e1e3;
    --panel-header-bg: #eaf1f2;
    --panel-brand: #0f4c5c;
    --panel-brand-strong: #0a3440;
    --panel-accent: #137c73;
    --panel-danger: #a11919;
    --panel-danger-bg: #fdecec;
    --panel-focus: #0b6f85;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html { background: var(--panel-bg); }
  body { max-width: 96rem; min-width: 0; margin: 0 auto; padding: 1rem; color: var(--panel-text); background: var(--panel-bg); overflow-wrap: anywhere; }
  header, section { min-width: 0; background: var(--panel-surface); border: 1px solid var(--panel-border); border-radius: .85rem; padding: 1rem; margin-bottom: 1rem; box-shadow: 0 .2rem .8rem rgb(15 76 92 / 7%); }
  .app-header { padding: 1.25rem 1.5rem; color: white; background: var(--panel-brand-strong); border-color: var(--panel-brand-strong); }
  .app-header h1 { margin: 0; font-size: clamp(1.55rem, 3vw, 2.15rem); letter-spacing: -.02em; }
  .app-eyebrow { margin: 0 0 .3rem; color: #a9ddd7; font-size: .78rem; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
  .app-subtitle { margin: .45rem 0 0; color: #dbeaec; }
  .app-header #status-region { color: #d7f5ed; }
  .app-header #error-region { color: #ffd6d6; }
  .security-notice { margin-top: .9rem; padding-top: .75rem; border-top: 1px solid rgb(255 255 255 / 24%); }
  .security-notice summary { cursor: pointer; font-weight: 700; }
  .security-notice p { max-width: 80rem; margin: .65rem 0 0; color: #e5eff1; line-height: 1.55; }
  main { min-width: 0; }
  section section { background: var(--panel-header-bg); margin-top: 1rem; margin-bottom: 0; }
  h1, h2, h3 { line-height: 1.25; }
  h2 { margin-top: 0; }
  p, li, dd { line-height: 1.5; }
  form { display: flex; flex-wrap: wrap; gap: .75rem; align-items: end; }
  label { font-weight: 600; }
  input, select, textarea, button { max-width: 100%; min-width: 0; min-height: 2.75rem; padding: .55rem .7rem; font: inherit; }
  input, select, textarea { border: 1px solid #9fb0b5; border-radius: .45rem; background: white; color: var(--panel-text); }
  textarea { width: min(100%, 42rem); resize: vertical; }
  button { cursor: pointer; border: 1px solid var(--panel-border); border-radius: .45rem; background: white; color: var(--panel-text); font-weight: 650; }
  button:hover { background: var(--panel-header-bg); }
  button:disabled { cursor: not-allowed; opacity: .6; }
  .btn-primary { color: white; background: var(--panel-accent); border-color: var(--panel-accent); }
  .btn-primary:hover { background: #0e675f; }
  :focus-visible { outline: 3px solid var(--panel-focus); outline-offset: 2px; }
  .table-wrap, #overview-content { max-width: 100%; }
  .table-wrap { overflow-x: auto; }
  #overview-content { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; background: white; }
  th, td { padding: .65rem; border-bottom: 1px solid #e5e9f0; text-align: left; white-space: nowrap; }
  th { background: var(--panel-header-bg); }
  #error-region, [role="alert"] { color: var(--panel-danger); font-weight: 600; }
  #status-region, [role="status"] { font-weight: 600; }
  #section-nav { display: flex; flex-wrap: wrap; gap: .5rem; padding: .5rem; margin-bottom: 1rem; background: white; border: 1px solid var(--panel-border); border-radius: .75rem; box-shadow: 0 .2rem .8rem rgb(15 76 92 / 7%); }
  #section-nav .nav-tab { background: var(--panel-header-bg); }
  #section-nav .nav-tab[aria-current="true"] { background: var(--panel-brand); color: white; border-color: var(--panel-brand); }
  .btn-danger { background: white; border: 2px solid var(--panel-danger); color: var(--panel-danger); font-weight: 600; }
  .btn-danger:hover { background: var(--panel-danger-bg); }
  @media (max-width: 42rem) {
    body { padding: .5rem; }
    header, section { padding: .85rem; }
    .app-header { padding: 1rem; }
    form { display: grid; grid-template-columns: minmax(0, 1fr); align-items: stretch; }
    input, select, textarea, form button { width: 100%; }
    #section-nav { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    #section-nav .nav-tab { width: 100%; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }
`;

export const PANEL_STYLES_CSP_HASH = "'sha256-YPvTUDSxjpMTosU17ou+TQQ+PibSHCUhQCJMsxMJLoY='";
