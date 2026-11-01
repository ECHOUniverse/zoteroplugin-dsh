/**
 * Stylesheet for the right-sidebar tab, injected once per application.
 *
 * Follows the DSH host: every color/radius/font reads a `--dsw-*` alias
 * variable (theme + host style variables propagate), with conservative
 * fallbacks so the tab still renders sensibly outside DSH. Layout is a flex
 * column that works at right-pane width (~280px) and in fullscreen; controls
 * keep visible focus rings and full keyboard reachability.
 *
 * @module @hanxu131/dsh-zotero/client/styles
 */

export const CSS = String.raw`
.dshZot {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font: inherit;
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-bg-base, transparent);
}
.dshZot * { box-sizing: border-box; }
.dshZot :focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, currentColor);
  outline-offset: 1px;
}
.dshZot button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
.dshZot button:disabled { cursor: default; opacity: 0.55; }
.dshZotIcon { flex: none; vertical-align: -2px; }

/* --- buttons ------------------------------------------------------- */
.dshZotBtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1));
  font-size: 12px;
  line-height: 16px;
  white-space: nowrap;
}
.dshZotBtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); }
.dshZotPrimary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary, #333)); color: var(--dsw-alias-label-primary-foreground, #fff); border-color: transparent; }
.dshZotPrimary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-label-primary, #333)); }
.dshZotGhost { border-color: transparent; }
.dshZotGhost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); }
.dshZotIconOnly { padding: 4px; border-radius: var(--dsw-radius-sm, 6px); }
.dshZotActive { background: var(--dsw-alias-interactive-bg-active, rgba(0,0,0,0.09)); }
.dshZotLink { padding: 0; color: var(--dsw-alias-link, var(--dsw-alias-label-secondary, inherit)); text-decoration: underline; font-size: 12px; }

/* --- bars ---------------------------------------------------------- */
.dshZotBar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08));
  flex: none;
  min-height: 36px;
  flex-wrap: wrap;
}
.dshZotBack { display: inline-flex; align-items: center; gap: 2px; padding: 4px 6px 4px 2px; border-radius: var(--dsw-radius-sm, 6px); font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
.dshZotBack:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); }
.dshZotBarTitle { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); min-width: 0; }
.dshZotStrong { font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.dshZotGrow { flex: 1 1 0; min-width: 0; }
.dshZotCount { font-size: 11px; color: var(--dsw-alias-label-tertiary, inherit); white-space: nowrap; }

/* --- search -------------------------------------------------------- */
.dshZotSearch {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 6px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08));
  flex: none;
}
.dshZotSearch input[type="search"] {
  flex: 1 1 40px;
  min-width: 0;
  font: inherit;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12));
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: inherit;
}
.dshZotSearch input[type="search"]::placeholder { color: var(--dsw-alias-label-tertiary, inherit); }
.dshZotToggle { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary, inherit); white-space: nowrap; }
.dshZotToggle input { accent-color: var(--dsw-alias-brand-primary, currentColor); margin: 0; }

/* --- menus --------------------------------------------------------- */
.dshZotMenuAnchor { position: relative; display: inline-flex; }
.dshZotScopeBtn { max-width: 46vw; }
.dshZotMenu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 20;
  min-width: 200px;
  max-width: 84vw;
  max-height: 60vh;
  overflow: auto;
  background: var(--dsw-alias-bg-layer-2, #fff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12));
  border-radius: var(--dsw-radius-md, 10px);
  box-shadow: 0 4px 16px rgba(0,0,0,0.14);
  padding: 4px;
}
.dshZotMenu.right { left: auto; right: 0; }
.dshZotMenuLabel { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dsw-alias-label-tertiary, inherit); padding: 6px 8px 2px; }
.dshZotMenuSep { height: 1px; background: var(--dsw-alias-border-l2, rgba(0,0,0,0.08)); margin: 4px 2px; }
.dshZotMenuRow { display: flex; align-items: center; gap: 4px; border-radius: var(--dsw-radius-sm, 6px); }
.dshZotMenuRow.current { background: var(--dsw-alias-interactive-bg-active, rgba(0,0,0,0.07)); }
.dshZotTwisty { width: 18px; height: 24px; display: inline-flex; align-items: center; justify-content: center; flex: none; color: var(--dsw-alias-label-tertiary, inherit); }
.dshZotMenuPick { display: inline-flex; align-items: center; gap: 6px; flex: 1; min-width: 0; padding: 4px 6px 4px 0; font-size: 12px; text-align: left; }
.dshZotMenuPick .dshZotMenuCount { margin-left: auto; }

/* --- item list ------------------------------------------------------ */
.dshZotScroll { flex: 1 1 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.dshZotList { list-style: none; margin: 0; padding: 2px 4px 8px; }
.dshZotRow { display: flex; align-items: flex-start; gap: 2px; border-radius: var(--dsw-radius-sm, 6px); }
.dshZotRow.selected { background: var(--dsw-alias-interactive-bg-active, rgba(0,0,0,0.07)); }
.dshZotRow:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); }
.dshZotCheck { width: 22px; height: 30px; display: inline-flex; align-items: center; justify-content: center; flex: none; color: var(--dsw-alias-label-secondary, inherit); border-radius: var(--dsw-radius-xs, 4px); }
.dshZotRowMain { display: flex; flex-direction: column; gap: 1px; flex: 1 1 0; min-width: 0; padding: 4px 2px; text-align: left; border-radius: var(--dsw-radius-xs, 4px); }
.dshZotRowTitle { font-size: 12.5px; line-height: 17px; color: var(--dsw-alias-label-primary, inherit); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.dshZotRowMeta { display: flex; gap: 6px; font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary, inherit); min-width: 0; }
.dshZotRowType { flex: none; color: var(--dsw-alias-label-tertiary, inherit); }
.dshZotRowMetaText { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshZotPdfChip {
  flex: none;
  margin-top: 4px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  font-size: 10px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.16));
  color: var(--dsw-alias-label-secondary, inherit);
}
.dshZotPdfChip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); }
.dshZotMore { display: flex; justify-content: center; padding: 8px 0; }

/* --- selection bar --------------------------------------------------- */
.dshZotSelectionBar {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08));
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.dshZotSelectionRow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

/* --- ask box --------------------------------------------------------- */
.dshZotAskBox { display: flex; flex-direction: column; gap: 6px; }
.dshZotAskBox textarea {
  width: 100%;
  font: inherit;
  font-size: 12px;
  line-height: 17px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.16));
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: inherit;
  resize: vertical;
}
.dshZotAskActions { display: flex; justify-content: flex-end; gap: 6px; }

/* --- empty / toast ---------------------------------------------------- */
.dshZotEmpty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 32px 16px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); text-align: center; }
.dshZotToast {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 88%;
  padding: 6px 12px;
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-tooltip-bg, var(--dsw-alias-label-primary, #333));
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font-size: 12px;
  cursor: pointer;
  z-index: 30;
}

/* --- detail ------------------------------------------------------------ */
.dshZotDetail { padding: 10px 12px 16px; display: flex; flex-direction: column; gap: 12px; }
.dshZotDetailTitle { margin: 0; font-size: 15px; line-height: 20px; font-weight: 600; }
.dshZotCreators { margin: 0; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary, inherit); }
.dshZotActions { display: flex; gap: 6px; flex-wrap: wrap; }
.dshZotSection { border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08)); padding-top: 10px; }
.dshZotSectionHead { display: flex; align-items: baseline; gap: 6px; margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dsw-alias-label-tertiary, inherit); }
.dshZotAbstract { margin: 0; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary, inherit); white-space: pre-line; }
.dshZotAbstract.clamped { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; }
.dshZotFields { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 4px 16px; margin: 0; }
.dshZotFieldRow { display: flex; flex-direction: column; gap: 0; min-width: 0; }
.dshZotFieldRow dt { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dsw-alias-label-tertiary, inherit); }
.dshZotFieldRow dd { margin: 0; font-size: 12px; line-height: 17px; overflow-wrap: anywhere; }
.dshZotChips { display: flex; flex-wrap: wrap; gap: 6px; }
.dshZotChip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; font-size: 11px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); color: var(--dsw-alias-label-secondary, inherit); text-align: left; }
.dshZotChip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); }
.dshZotNote { border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08)); border-radius: var(--dsw-radius-sm, 6px); padding: 8px 10px; font-size: 12px; line-height: 17px; }
.dshZotNote.clamped .dshZotNoteBody { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; }
.dshZotNoteBody img { display: none; }
.dshZotNoteBody p { margin: 0 0 6px; }
.dshZotNoteBody p:last-child { margin-bottom: 0; }
.dshZotNoteBody a { color: var(--dsw-alias-link, inherit); }
.dshZotAttachments { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.dshZotAttachment { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 6px; border-radius: var(--dsw-radius-sm, 6px); text-align: left; font-size: 12px; }
.dshZotAttachment:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); }
.dshZotAttachmentTitle { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshZotAttachmentKind { flex: none; font-size: 10px; color: var(--dsw-alias-label-tertiary, inherit); }
.dshZotAnnotations { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.dshZotAnnotation { display: flex; gap: 8px; width: 100%; padding: 6px; border-radius: var(--dsw-radius-sm, 6px); text-align: left; }
.dshZotAnnotation:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); }
.dshZotSwatch { flex: none; width: 10px; height: 10px; border-radius: 3px; margin-top: 3px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); }
.dshZotAnnotationBody { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 12px; line-height: 16px; }
.dshZotAnnotationQuote { color: var(--dsw-alias-label-primary, inherit); }
.dshZotAnnotationComment { color: var(--dsw-alias-label-secondary, inherit); }
.dshZotAnnotationPage { font-size: 10px; color: var(--dsw-alias-label-tertiary, inherit); }

/* --- setup / status ----------------------------------------------------- */
.dshZotSetup { padding: 18px 14px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
.dshZotSetupHead { display: flex; align-items: center; gap: 10px; }
.dshZotSetupIcon { flex: none; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; border-radius: var(--dsw-radius-md, 10px); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); }
.dshZotSetupTitle { font-size: 14px; font-weight: 600; line-height: 19px; }
.dshZotSetupLead { margin: 0; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary, inherit); }
.dshZotSetupCard { border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); border-radius: var(--dsw-radius-md, 10px); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.dshZotSteps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; counter-reset: dshzot-step; }
.dshZotSteps li { display: flex; gap: 8px; font-size: 12px; line-height: 17px; }
.dshZotSteps li::before { counter-increment: dshzot-step; content: counter(dshzot-step); flex: none; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; background: var(--dsw-alias-interactive-bg-active, rgba(0,0,0,0.08)); font-size: 11px; margin-top: 1px; }
.dshZotSetupMeta { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, inherit); }
.dshZotErrorBox { margin: 0; padding: 8px 10px; border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-state-error-secondary, rgba(200,40,40,0.08)); color: var(--dsw-alias-state-error-primary, #b3261e); font-size: 11px; line-height: 16px; overflow-wrap: anywhere; white-space: pre-wrap; }
.dshZotLamp { flex: none; width: 8px; height: 8px; border-radius: 999px; background: var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-tertiary, #888)); }
.dshZotLamp.ok { background: var(--dsw-alias-state-success-primary, #1a7f37); }
.dshZotLamp.bad { background: var(--dsw-alias-state-error-primary, #b3261e); }
.dshZotLamp.warn { background: var(--dsw-alias-state-warn-primary, #b58a00); }

/* --- reader boundary ------------------------------------------------------ */
.dshZotReader { padding: 18px 14px; display: flex; flex-direction: column; gap: 10px; }
.dshZotReaderNote { border: 1px dashed var(--dsw-alias-border-l3, rgba(0,0,0,0.16)); border-radius: var(--dsw-radius-md, 10px); padding: 10px 12px; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary, inherit); }

/* --- PDF reader (lazy chunk) ---------------------------------------------- */
.dshZotReaderFull { height: 100%; }
.dshZotReaderBody { display: flex; flex-direction: row; min-height: 0; flex: 1; }
.dshZotPager { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
.dshZotPager input { width: 38px; text-align: center; padding: 3px 4px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: inherit; }
.dshZotZoom.dshZotActive { border-color: var(--dsw-alias-brand-primary, currentColor); }
.dshZotPages { position: relative; flex: 1; overflow: auto; min-width: 0; }
.dshZotPageStack { display: flex; flex-direction: column; align-items: center; gap: 12px; min-width: min-content; padding-left: 12px; padding-right: 12px; }
.dshZotPage { position: relative; flex: none; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.04); }
.dshZotPage canvas { position: absolute; inset: 0; display: block; }
.dshZotPage canvas.dshZotPending { visibility: hidden; }
/* pdf.js text layer (class names on the container are ours; inner spans are pdf.js's) */
.dshZotTextLayer {
  position: absolute; text-align: initial; inset: 0; overflow: clip; opacity: 1; line-height: 1;
  -webkit-text-size-adjust: none; text-size-adjust: none; forced-color-adjust: none; transform-origin: 0 0;
  caret-color: CanvasText; z-index: 2;
  --min-font-size: 1;
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
}
.dshZotTextLayer :is(span, br) { color: transparent; position: absolute; white-space: pre; cursor: text; transform-origin: 0% 0%; user-select: text; }
.dshZotTextLayer > :not(.markedContent),
.dshZotTextLayer .markedContent span:not(.markedContent) {
  z-index: 1; --font-height: 0;
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  --scale-x: 1; --rotate: 0deg;
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
}
.dshZotPage.dshZotOverMark .dshZotTextLayer :is(span, br) { cursor: pointer; }
.dshZotTextLayer .markedContent { display: contents; }
.dshZotTextLayer span[role="img"] { user-select: none; cursor: default; }
.dshZotTextLayer ::selection { background: rgba(0, 100, 255, 0.28); color: transparent; }
.dshZotTextLayer br::selection { background: transparent; }
.dshZotTextLayer .endOfContent { display: block; position: absolute; inset: 100% 0 0; z-index: 0; cursor: default; user-select: none; }
.dshZotMarks { position: absolute; inset: 0; z-index: 1; pointer-events: none; }
.dshZotMark {
  position: absolute; border: 0; padding: 0; margin: 0; pointer-events: none; mix-blend-mode: multiply;
  background: color-mix(in srgb, var(--mark) 45%, transparent); border-radius: 1px; cursor: pointer;
}
.dshZotMark_underline { background: none; border-bottom: 2px solid var(--mark); mix-blend-mode: normal; }
.dshZotMark_image, .dshZotMark_text { background: none; outline: 2px solid var(--mark); mix-blend-mode: normal; }
.dshZotMark_note { background: var(--mark); border-radius: 3px; mix-blend-mode: normal; box-shadow: 0 1px 2px rgba(0,0,0,0.3); }
.dshZotMark_agent { background: color-mix(in srgb, var(--mark) 32%, transparent); box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--mark) 85%, #000); }
.dshZotMarkFocused { animation: dshZotPulse 1.2s ease-out 2; outline: 2px solid color-mix(in srgb, var(--mark) 80%, #000); outline-offset: 1px; }
.dshZotMarkBadge { position: absolute; left: -14px; top: -2px; font-size: 10px; line-height: 1; color: color-mix(in srgb, var(--mark) 80%, #000); mix-blend-mode: normal; }
@keyframes dshZotPulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--mark) 70%, transparent); }
  100% { box-shadow: 0 0 0 9px color-mix(in srgb, var(--mark) 0%, transparent); }
}
.dshZotFloatTools { position: absolute; z-index: 5; display: inline-flex; gap: 6px; background: var(--dsw-alias-bg-raised, #fff); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12)); border-radius: var(--dsw-radius-md, 8px); padding: 4px; box-shadow: 0 4px 14px rgba(0,0,0,0.18); }
.dshZotPopover { position: absolute; z-index: 6; width: min(280px, 92vw); display: flex; flex-direction: column; gap: 6px; background: var(--dsw-alias-bg-raised, #fff); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12)); border-radius: var(--dsw-radius-md, 8px); padding: 10px; box-shadow: 0 6px 18px rgba(0,0,0,0.2); font-size: 12px; }
.dshZotPopoverHead { display: flex; align-items: center; gap: 6px; }
.dshZotPopoverQuote { margin: 0; max-height: 96px; overflow: auto; line-height: 16px; }
.dshZotPopoverComment { margin: 0; color: var(--dsw-alias-label-secondary, inherit); }
.dshZotPopoverActions { display: flex; gap: 6px; align-items: center; }
.dshZotWho { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; }
.dshZotWhoAgent { color: #a28ae5; font-weight: 600; }
.dshZotMuted { color: var(--dsw-alias-label-secondary, inherit); }
.dshZotSmall { font-size: 11px; }
.dshZotPad { padding: 8px 10px; }
.dshZotReaderSidebar { width: 200px; flex: none; border-left: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); overflow: auto; }
.dshZotReaderSidebarHead { padding: 8px 10px; font-size: 12px; font-weight: 600; border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.08)); }
.dshZotAnnotationList { list-style: none; margin: 0; padding: 4px; display: flex; flex-direction: column; gap: 4px; }
.dshZotAnnotationRow { display: flex; gap: 6px; width: 100%; text-align: left; padding: 6px; border-radius: var(--dsw-radius-sm, 6px); align-items: flex-start; }
.dshZotAnnotationRow:hover { background: var(--dsw-alias-bg-hover, rgba(0,0,0,0.05)); }
.dshZotAnnotationAgent .dshZotSwatch { outline: 1px dashed var(--dsw-alias-border-l2, rgba(0,0,0,0.2)); }
.dshZotAnnotationFocused { outline: 2px solid var(--dsw-alias-brand-primary, currentColor); outline-offset: 0; }
.dshZotAnnotationBody { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dshZotAnnotationQuote { font-size: 11px; line-height: 15px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.dshZotAnnotationComment { font-size: 11px; color: var(--dsw-alias-label-secondary, inherit); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshZotProgress { width: 200px; height: 4px; border-radius: 2px; background: var(--dsw-alias-border-l2, rgba(0,0,0,0.12)); overflow: hidden; margin-bottom: 8px; }
.dshZotProgress > div { height: 100%; background: var(--dsw-alias-brand-primary, currentColor); }
.dshZotBanner { padding: 6px 12px; font-size: 12px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); background: var(--dsw-alias-bg-raised, transparent); }
.dshZotBannerWarn { color: var(--dsw-alias-label-secondary, inherit); }

/* app root hosts the toast; keep positioning stable in both pane sizes */
.dshZotRoot { position: relative; height: 100%; min-height: 0; }
`
