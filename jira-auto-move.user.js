// ==UserScript==
// @name         Jira Auto-Move → Firstup Engineering / Bug
// @namespace    firstup.jira.automove
// @version      2.9
// @description  One-click (or keyboard-shortcut) automation of the Jira "Move Issue" wizard, shown only on CSUP issues: Actions → Move → set project=Firstup Engineering (FE), type=Bug → Next → Next → Next → Confirm. Entire flow verified end-to-end against firstup-io.atlassian.net (CSUP-9292 → FE-36615).
// @author       Carl Walker
// @match        https://firstup-io.atlassian.net/*
// @run-at       document-idle
// @grant        none
//
// --- AUTO-UPDATE: replace REPLACE_ME below with your real host, then keep these
// --- URLs pointing at ONE stable file path (do NOT put a version in the URL;
// --- Tampermonkey compares the @version field inside the file to decide updates).
// @homepageURL  https://github.com/carlwalkerf1/jira-auto-move
// @updateURL    https://raw.githubusercontent.com/carlwalkerf1/jira-auto-move/main/jira-auto-move.user.js
// @downloadURL  https://raw.githubusercontent.com/carlwalkerf1/jira-auto-move/main/jira-auto-move.user.js
// @supportURL   mailto:carl.walker@firstup.io
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================================
   * CONFIG — matching is case-insensitive "contains", so partial text is fine.
   * ========================================================================= */
  const CFG = {
    TARGET_PROJECT: 'Firstup Engineering', // "New Project" picker
    TARGET_ISSUE_TYPE: 'Bug', // "New Issue Type" picker
    // Leave NEW_STATUS null to keep the wizard default (e.g. "Awaiting Triage").
    NEW_STATUS: null,
    // Optional values to type on the "Update fields" step, keyed by visible label.
    FIELD_VALUES: { /* 'QA Story Points': '3', 'Original Ticket': 'CSUP-123' */ },
    STEP_DELAY_MS: 350, // settle delay before acting on each wizard step
    WAIT_TIMEOUT_MS: 15000, // how long to wait for an element / suggestions
    // Safety: if true, the script fills everything and advances through the
    // wizard but STOPS on the final "Confirm changes" screen for you to review
    // and click Confirm yourself. Set to false for fully hands-off.
    STOP_BEFORE_CONFIRM: false,
    // Where the "Send to Carl" error button addresses its report.
    REPORT_TO: 'carl.walker@firstup.io',
    // Keyboard shortcut that fires the move (same as clicking the button).
    // Format: modifiers + key, e.g. 'Ctrl+Shift+M', 'Alt+M', 'Ctrl+Alt+B'.
    // Set to null to disable. Only fires on an open issue, never while typing.
    HOTKEY: 'Ctrl+Shift+M',
    // Only show the button / allow the shortcut on issues whose key starts with
    // this prefix (the move is <SOURCE_PREFIX> → Firstup Engineering).
    SOURCE_PREFIX: 'CSUP',
  };

  const FLAG = 'feAutoMove.active'; // sessionStorage flag that keeps it going across reloads

  /* ===================== small helpers ===================== */

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const has = (hay, needle) => norm(hay).includes(norm(needle));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);

  function visible(el) {
    if (!el) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function waitFor(predicate, { timeout = CFG.WAIT_TIMEOUT_MS, interval = 120 } = {}) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function tick() {
        let v; try { v = predicate(); } catch (e) { v = null; }
        if (v) return resolve(v);
        if (Date.now() - t0 > timeout) return reject(new Error('timed out waiting for element'));
        setTimeout(tick, interval);
      })();
    });
  }

  /* ===================== status badge ===================== */

  let badge;
  function status(msg, kind = 'info') {
    console.log('[FE AutoMove]', msg);
    if (!badge) {
      badge = document.createElement('div');
      Object.assign(badge.style, {
        position: 'fixed', bottom: '16px', right: '16px', zIndex: 2147483647,
        font: '13px/1.4 -apple-system,system-ui,sans-serif', color: '#fff',
        background: '#0052cc', padding: '8px 12px', borderRadius: '6px',
        boxShadow: '0 2px 8px rgba(0,0,0,.25)', maxWidth: '320px', pointerEvents: 'none',
      });
      document.body.appendChild(badge);
    }
    badge.style.background = kind === 'error' ? '#bf2600' : kind === 'done' ? '#006644' : '#0052cc';
    badge.textContent = 'Auto-Move: ' + msg;
  }

  /* ===================== diagnostics snapshot ===================== */
  // On failure, capture everything a human (or Claude) needs to re-point a
  // selector WITHOUT the live page: the active heading plus every candidate
  // control with its id, data-testid, and text. Logged, stashed on
  // window.__feAutoMoveSnapshot, and copied to the clipboard when possible.
  function buildSnapshot(reason) {
    const brief = (el) => ({
      tag: el.tagName,
      id: el.id || '',
      testid: el.getAttribute('data-testid') || '',
      name: el.getAttribute('name') || '',
      value: el.value || '',
      aria: el.getAttribute('aria-label') || '',
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    });
    const pick = (sel) => [...document.querySelectorAll(sel)].filter(visible).map(brief);

    const data = {
      reason,
      when: new Date().toISOString(),
      url: location.href,
      title: document.title,
      detectedStep: detectStep(),
      headings: [...document.querySelectorAll('h1,h2,h3')]
        .map((h) => h.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean),
      buttons: pick('button, input[type=submit], input[type=button], a[role="button"], a.aui-button')
        .slice(0, 40),
      fields: pick('input[type=text], input[role=combobox], textarea, select').slice(0, 40),
      // menu items (only meaningful when the Actions menu is open)
      menuItems: pick('[role="menuitem"]').slice(0, 30),
    };
    window.__feAutoMoveSnapshot = data;
    return data;
  }

  // Best-effort clipboard copy. Reliable inside a click handler (user gesture).
  function copyText(text) {
    try {
      if (navigator.clipboard) { navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (e) { return false; }
  }

  // Compose the prefilled report email. The full JSON is copied to the
  // clipboard on the same click; a readable summary goes in the mailto body
  // (mailto: bodies are length-limited, so we keep the summary compact).
  function sendReport(data, json) {
    copyText(json);
    const top = (arr, n) => (arr || []).slice(0, n)
      .map((b) => `  - ${[b.id && '#' + b.id, b.testid, b.text].filter(Boolean).join(' | ')}`)
      .join('\n');
    const body =
`Jira Auto-Move stopped with an error.

Reason:   ${data.reason}
Step:     ${data.detectedStep || '(not detected)'}
Page:     ${data.url}
Time:     ${data.when}
Headings: ${(data.headings || []).join('  |  ')}

Buttons found on the page:
${top(data.buttons, 8) || '  (none)'}

Fields found on the page:
${top(data.fields, 8) || '  (none)'}

----------------------------------------------------------------
Full diagnostics were copied to my clipboard — pasting below:

`;
    const url = 'mailto:' + encodeURIComponent(CFG.REPORT_TO) +
      '?subject=' + encodeURIComponent('[Jira Auto-Move] failed: ' + data.reason) +
      '&body=' + encodeURIComponent(body);
    const a = document.createElement('a');
    a.href = url; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // Shared failure path: red panel with report/copy buttons + console dump.
  function fail(err) {
    sessionStorage.removeItem(FLAG);
    const data = buildSnapshot(err.message);
    const json = JSON.stringify(data, null, 2);
    console.groupCollapsed('%c[FE AutoMove] DIAGNOSTIC SNAPSHOT', 'color:#bf2600;font-weight:bold');
    console.log(json);
    console.groupEnd();
    showErrorPanel(err.message, data, json);
  }

  // Interactive error panel (the status badge is non-interactive, so failures
  // get their own panel with clickable buttons).
  let errPanel;
  function showErrorPanel(msg, data, json) {
    if (badge) { badge.remove(); badge = null; }
    if (errPanel) errPanel.remove();
    errPanel = document.createElement('div');
    Object.assign(errPanel.style, {
      position: 'fixed', bottom: '16px', right: '16px', zIndex: 2147483647,
      font: '13px/1.45 -apple-system,system-ui,sans-serif', color: '#fff',
      background: '#bf2600', padding: '12px 14px', borderRadius: '8px',
      boxShadow: '0 4px 16px rgba(0,0,0,.3)', maxWidth: '340px',
    });
    const title = document.createElement('div');
    title.textContent = 'Auto-Move stopped: ' + msg;
    title.style.marginBottom = '10px';
    errPanel.appendChild(title);

    const mkBtn = (label, onClick) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      Object.assign(btn.style, {
        font: '12px -apple-system,system-ui,sans-serif', cursor: 'pointer',
        border: 'none', borderRadius: '5px', padding: '7px 10px', marginRight: '6px',
        background: '#fff', color: '#bf2600', fontWeight: '600',
      });
      btn.addEventListener('click', onClick);
      return btn;
    };

    errPanel.appendChild(mkBtn('✉ Send to Carl', () => {
      sendReport(data, json);
      title.textContent = 'Report opened in your mail app — full details copied, paste & send.';
    }));
    errPanel.appendChild(mkBtn('⧉ Copy diagnostics', (e) => {
      const ok = copyText(json);
      e.target.textContent = ok ? '✓ Copied' : 'Copy failed — see console';
    }));
    errPanel.appendChild(mkBtn('✕', () => errPanel.remove()));
    document.body.appendChild(errPanel);
  }

  /* ===================== AUI single-select driver ===================== */
  // Verified flow: type into the visible field → wait for the async suggestion
  // list → click the matching <a class="aui-list-item-link">. This fires all of
  // Jira's internal wiring (e.g. the issue-type list repopulating per project).
  async function setAuiPicker(fieldId, suggestionsId, wantedText) {
    const field = await waitFor(() => $('#' + fieldId));
    field.focus();
    field.value = wantedText;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));

    const link = await waitFor(() => {
      const sug = $('#' + suggestionsId);
      if (!sug || !visible(sug)) return null;
      const links = [...sug.querySelectorAll('a.aui-list-item-link')];
      return links.find((a) => has(a.textContent, wantedText)) || null;
    });
    link.click();
  }

  /* ===================== step detection ===================== */

  function onWizard() {
    return /\/secure\/MoveIssue/i.test(location.pathname + location.search) ||
           /Move Issue:/i.test(document.title);
  }

  function detectStep() {
    if (!onWizard()) return null;
    // The left-nav lists all four step labels on every page, so body text is
    // ambiguous. The ACTIVE step is the single content <h2> (verified: e.g.
    // "Update fields for 'Bug' issues…", "Confirm changes"). Key off that.
    const heading = norm([...document.querySelectorAll('h1,h2,h3')]
      .map((h) => h.textContent)
      .find((t) => t && !/^\s*move issue\s*$/i.test(t)) || '');
    if (has(heading, 'select destination')) return 'select';
    if (has(heading, 'map statuses')) return 'mapstatus';
    if (has(heading, 'update fields')) return 'updatefields';
    if (has(heading, 'confirm changes')) return 'confirm';
    // Fallback for step 1 if the heading text ever shifts.
    if ($('#project-field') && $('#issuetype-field')) return 'select';
    return null;
  }

  /* ===================== step handlers ===================== */

  async function stepSelect() {
    status('Setting project → ' + CFG.TARGET_PROJECT);
    await setAuiPicker('project-field', 'project-suggestions', CFG.TARGET_PROJECT);
    await sleep(600); // issue-type list repopulates after project changes
    status('Setting issue type → ' + CFG.TARGET_ISSUE_TYPE);
    await setAuiPicker('issuetype-field', 'issuetype-suggestions', CFG.TARGET_ISSUE_TYPE);
    // sanity check the hidden values before submitting
    const pOk = has($('#project-field')?.value, CFG.TARGET_PROJECT);
    const tOk = has($('#issuetype-field')?.value, CFG.TARGET_ISSUE_TYPE);
    if (!pOk || !tOk) throw new Error('Values did not stick (project/type). Stopping.');
    await clickNext();
  }

  async function stepMapStatus() {
    status('Mapping statuses…');
    if (CFG.NEW_STATUS) {
      const sel = [...document.querySelectorAll('select')]
        .find((s) => [...s.options].some((o) => has(o.textContent, CFG.NEW_STATUS)));
      if (sel) {
        const opt = [...sel.options].find((o) => has(o.textContent, CFG.NEW_STATUS));
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    await clickNext();
  }

  async function stepUpdateFields() {
    status('Updating fields…');
    for (const [label, value] of Object.entries(CFG.FIELD_VALUES || {})) {
      const lab = [...document.querySelectorAll('label')].find((l) => has(l.textContent, label));
      const input = lab && (document.getElementById(lab.getAttribute('for')) ||
                            lab.closest('tr, .field-group, div')?.querySelector('input, textarea'));
      if (input) {
        input.value = value;
        ['input', 'change'].forEach((t) => input.dispatchEvent(new Event(t, { bubbles: true })));
      }
    }
    await clickNext();
  }

  async function stepConfirm() {
    if (CFG.STOP_BEFORE_CONFIRM) {
      sessionStorage.removeItem(FLAG);
      status('Ready — review, then click Confirm yourself.', 'done');
      return;
    }
    status('Confirming move…');
    // Verified: the final button is <input type=submit id="move_submit"
    // name="Confirm" value="Confirm">. Fall back defensively just in case.
    const btn = await waitFor(() =>
      $('#move_submit') ||
      [...document.querySelectorAll('input[type=submit], button, a.aui-button')]
        .filter(visible)
        .find((b) => /confirm|move|finish/i.test(b.value || b.textContent)));
    sessionStorage.removeItem(FLAG); // done regardless of outcome
    btn.click();
    status('Move submitted ✔', 'done');
    setTimeout(() => badge && badge.remove(), 5000);
  }

  async function clickNext() {
    const btn = await waitFor(() => $('#next_submit') || (function () {
      return [...document.querySelectorAll('input[type=submit], button, a.aui-button')]
        .filter(visible).find((b) => /^\s*next\s*$/i.test(b.value || b.textContent));
    })());
    btn.click(); // full page reload → run() re-enters on the next step
  }

  /* ===================== kick-off from the issue view ===================== */

  async function startFromIssue() {
    status('Opening Actions menu…');
    const trigger = await waitFor(() =>
      $('[data-testid="issue-meatball-menu.ui.dropdown-trigger.button"]'));
    trigger.click();

    const move = await waitFor(() =>
      $('[data-testid="issue-view-foundation.issue-actions.issue-manipulation-dropdown-group.move-issue.styled-section-move-issue"]') ||
      [...document.querySelectorAll('[role="menuitem"]')].find((m) => norm(m.textContent) === 'move'));
    sessionStorage.setItem(FLAG, '1');
    status('Starting move…');
    move.click(); // navigates to /secure/MoveIssue!default.jspa
  }

  /* ===================== floating start button ===================== */

  // The CURRENT issue's key, resolved independently of the URL (dashboard links
  // carry query-string junk, so the URL is unreliable). Primary signal is the
  // breadcrumb's current-issue item (verified testid; not confused by linked
  // items, which use different testids). Fallbacks: tab title, then the URL.
  function currentIssueKey() {
    const bc = document.querySelector(
      '[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]');
    if (bc) {
      const t = (bc.textContent || '').trim();
      if (/^[A-Z][A-Z0-9]+-\d+$/.test(t)) return t;
      const hm = (bc.getAttribute('href') || '').match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
      if (hm) return hm[1];
    }
    let m = (document.title || '').match(/\[([A-Z][A-Z0-9]+-\d+)\]/);
    if (m) return m[1];
    m = location.href.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/) ||
        location.href.match(/[?&]selectedIssue=([A-Z][A-Z0-9]+-\d+)/);
    return m ? m[1] : null;
  }

  // Only show/fire on a <SOURCE_PREFIX> issue (the move is CSUP → FE). Excludes
  // the wizard and non-CSUP issues (e.g. an already-moved FE ticket).
  function onCsupIssue() {
    if (onWizard()) return false;
    const key = currentIssueKey();
    return !!key && key.toUpperCase().startsWith((CFG.SOURCE_PREFIX + '-').toUpperCase());
  }

  function injectStartButton() {
    const b = document.createElement('button');
    b.id = 'fe-automove-btn';
    b.textContent = '⤷ Move → FE / Bug';
    Object.assign(b.style, {
      position: 'fixed', bottom: '16px', left: '16px', zIndex: 2147483647,
      background: '#0052cc', color: '#fff', border: 'none', borderRadius: '6px',
      padding: '10px 14px', font: '13px -apple-system,system-ui,sans-serif',
      cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,.25)',
    });
    if (CFG.HOTKEY) b.title = 'Keyboard shortcut: ' + CFG.HOTKEY;
    b.addEventListener('click', () => startFromIssue().catch(fail));
    document.body.appendChild(b);
  }

  // Show the button on a CSUP issue; remove it otherwise (idempotent).
  function updateButton() {
    const existing = document.getElementById('fe-automove-btn');
    if (onCsupIssue()) { if (!existing) injectStartButton(); }
    else if (existing) existing.remove();
  }

  /* ===================== main dispatcher ===================== */

  let running = false; // guards the wizard step handlers against re-entry
  async function runStep(step) {
    if (running) return;
    running = true; // stays set for this page load; a full reload resets it
    await sleep(CFG.STEP_DELAY_MS);
    try {
      if (step === 'select') await stepSelect();
      else if (step === 'mapstatus') await stepMapStatus();
      else if (step === 'updatefields') await stepUpdateFields();
      else if (step === 'confirm') await stepConfirm();
    } catch (e) {
      fail(e);
    }
  }

  function tick() {
    const active = sessionStorage.getItem(FLAG) === '1';
    const step = detectStep();
    if (step && active) runStep(step);
    else updateButton();
  }

  // The wizard is classic full-page loads (caught by the load event); the issue
  // view is a SPA that renders late and swaps issues without reloading, so we
  // also re-run tick() on DOM mutations (debounced). tick() is idempotent — it
  // just injects/removes the button as needed and never double-runs a step.
  let debounce;
  new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(tick, 250);
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('load', () => setTimeout(tick, 400));
  setTimeout(tick, 600);

  /* ===================== keyboard shortcut ===================== */

  function parseHotkey(str) {
    if (!str) return null;
    const parts = str.split('+').map((p) => p.trim().toLowerCase());
    const key = parts.pop();
    return {
      ctrl: parts.includes('ctrl') || parts.includes('control'),
      shift: parts.includes('shift'),
      alt: parts.includes('alt') || parts.includes('option'),
      meta: parts.includes('meta') || parts.includes('cmd') || parts.includes('command'),
      key,
    };
  }

  function isEditable(el) {
    if (!el) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
           el.tagName === 'SELECT' || el.isContentEditable;
  }

  const HOTKEY = parseHotkey(CFG.HOTKEY);
  if (HOTKEY) {
    // Capture phase so Jira's own key handling doesn't swallow it first.
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return; // ignore auto-repeat while held
      if (e.ctrlKey !== HOTKEY.ctrl || e.shiftKey !== HOTKEY.shift ||
          e.altKey !== HOTKEY.alt || e.metaKey !== HOTKEY.meta) return;
      if ((e.key || '').toLowerCase() !== HOTKEY.key) return;
      if (isEditable(document.activeElement)) return; // not while typing
      if (!onCsupIssue()) return; // only on a CSUP issue
      e.preventDefault();
      e.stopPropagation();
      startFromIssue().catch(fail);
    }, true);
  }
})();
