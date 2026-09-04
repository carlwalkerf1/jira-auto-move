// ==UserScript==
// @name         Jira Auto-Move → Firstup Engineering / Bug
// @namespace    firstup.jira.automove
// @version      3.21
// @description  One-click (or keyboard-shortcut) CSUP move that ROUTES by Primary Engineering Domain Team: standard teams → FE/Bug + full field populate (incl. copying the Description into the "CSUP ticket" field); Operations → CLOUD/Story + unassign; EEM → open-and-do-manually; blank/deprecated/unsupported → guidance banner + PSE tab. Reloads so new values show, then reminds of empty manual fields. Verified against firstup-io.atlassian.net.
// @author       Carl Walker
// @match        https://firstup-io.atlassian.net/*
// @run-at       document-idle
// @grant        none
//
// Auto-update: these URLs point at ONE stable file in the repo. Bumping the
// @version inside that file is what tells everyone's Tampermonkey to pull it.
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
    // Destination project/type per route (matched by text in the Move wizard).
    FE_PROJECT: 'Firstup Engineering', FE_TYPE: 'Bug',
    NON_DEPLOY_TYPE: 'Non-Deploy', // EEM with Bug = No goes here instead of Bug
    CLOUD_PROJECT: 'Cloud Operations', CLOUD_TYPE: 'Story',
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
    // --- Move Back (private test-cleanup tool) ---
    // Reverse an already-moved FE issue back to a CSUP as "Customer Issue - Dynamic"
    // (fewest required fields on the move), for re-testing/cleanup without minting new
    // CSUPs. Gated to specific accounts so it's invisible/undiscoverable to the team:
    // no button, hotkey only, and a confirm before it acts. The CSUP still has to be
    // deleted manually afterward (we never auto-delete).
    MOVE_BACK_ENABLED: true,
    MOVE_BACK_HOTKEY: 'Ctrl+Shift+B',
    MOVE_BACK_ACCOUNT_IDS: ['61a8d611c75da800720c3817'], // Carl only
    MOVE_BACK_PROJECT: 'Customer Support',
    MOVE_BACK_TYPE: 'Customer Issue - Dynamic',
    msgMoveBackConfirm: (key) => 'Move ' + key + ' back to Customer Support as “Customer Issue - Dynamic” (test cleanup)? You’ll still need to delete the CSUP manually afterward.',
    // Only show the button / allow the shortcut on issues whose key starts with
    // this prefix (the move is <SOURCE_PREFIX> → Firstup Engineering).
    SOURCE_PREFIX: 'CSUP',
    // CSUP issue types Auto-Move does NOT support. Everything the tool does
    // assumes "Customer Issue - Firstup"; "Customer Issue - Dynamic" (the Signal
    // product, on its way out) is intentionally unsupported. On these, the button
    // is hidden and the shortcut/REST path refuses with MSG_UNSUPPORTED_TYPE.
    UNSUPPORTED_TYPE_NAMES: ['Customer Issue - Dynamic'],
    // Stamp the source CSUP key into the FE "Original Ticket" field during the
    // move. Disabled in v3.16 (redundant — no one queried it), re-enabled in v3.20
    // as an invisible marker for adoption tracking: any FE issue with this field
    // populated was moved by Auto-Move (manual moves never fill it in), which lets
    // "% of CSUP→FE moves done via the tool" be measured via JQL — no visible
    // label needed.
    STAMP_ORIGINAL_TICKET: true,
    ORIGINAL_TICKET_FIELD_ID: 'customfield_13149',
    // Show a banner on the destination issue confirming the move + field writes.
    POST_MOVE_BANNER: true,
    // Reload the destination issue after the writes so the new values actually
    // appear (Jira's issue view doesn't live-update on external REST writes).
    // The confirmation + reminder are re-shown after the reload.
    RELOAD_AFTER_POPULATE: true,

    // --- Post-move field population (replaces the disabled Studio flow) ---
    // The script sets these on the destination FE Bug via REST, as you, right
    // after the move. All ids verified live against firstup-io.atlassian.net.
    POPULATE_FIELDS: true,
    // Constant fields → option id.
    CONST_FIELDS: {
      customfield_13269: '14457', // Reporting Source = Support
      customfield_13240: '14271', // Investment Profile = Customer Issue
      customfield_16340: '17905', // Support Actions Complete = No
    },
    // After the move, remind the user of any of these that are still EMPTY
    // (skips ones they've already set). Shown as a dismissable checklist banner.
    REMIND_EMPTY: true,
    // Post-move reminder for fields a human must judge. Bug + Customer Impact are
    // NOT here — they're now REQUIRED before the move (see REQUIRED_BEFORE_MOVE).
    REMINDER_FIELDS: [
      { id: 'customfield_13268', label: 'Escalated?' },
      { id: 'customfield_13258', label: 'Regression' },
    ],
    // Fields that must be set on the CSUP BEFORE an FE-bound move (else it's
    // blocked with a banner). Previously these were nagged about after the move.
    REQUIRED_BEFORE_MOVE: [
      { id: 'customfield_13599', label: 'Customer Impact', srcKey: 'customerImpact' },
      { id: 'customfield_13228', label: 'Bug', srcKey: 'bug' },
    ],
    // Move the previous assignee into Reporter, then unassign (FE and CLOUD routes).
    REASSIGN: true,
    // If the CSUP had NO assignee (the PSE forgot to assign it to themselves before
    // moving), fall back to setting Reporter = whoever ran Auto-Move, rather than
    // leaving Reporter unset. Low-risk: Reporter is informational and always
    // correctable by hand; set to false to require self-assigning before moving.
    REPORTER_FALLBACK_TO_SELF: true,
    // Copy the (moved) issue's Description ADF into the FE "CSUP ticket" field
    // (rich-text/textarea → preserves formatting; images resolve as the
    // attachments moved with the issue). Best-effort: failure never blocks the move.
    COPY_DESCRIPTION: true,
    CSUP_TICKET_FIELD_ID: 'customfield_15203', // "CSUP ticket" (textarea/rich text)
    // Capture PSE-role-restricted comments before the move (they vanish after),
    // then a post-move checklist lets the user append chosen ones into PSE Notes.
    HANDLE_PSE_COMMENTS: true,
    PSE_NOTES_FIELD_ID: 'customfield_15204', // "PSE Notes" (textarea/rich text)
    PSE_ROLE_NAME: 'PSE', // comment visibility value/identifier that marks a PSE comment
    // Reload after a successful PSE-comment save so the written PSE Notes shows
    // (Jira view is stale post-write). Only fires on Save, never Dismiss.
    RELOAD_AFTER_PSE_SAVE: true,
    // Source field driving the routing + FE Domain/ENG-Team destination fields.
    SOURCE_TEAM_FIELD_ID: 'customfield_13198', // Primary Engineering Domain Team
    BUG_FIELD_ID: 'customfield_13228',         // "Bug" (Yes/No/TBD) — picks the EEM issue type; required before move
    CUSTOMER_IMPACT_FIELD_ID: 'customfield_13599', // "Customer Impact" — required before move
    ENG_TEAM_FIELD_ID: 'customfield_13254',
    DOMAIN_FIELD_ID: 'customfield_13237',

    // Routing by Primary Engineering Domain Team value (exact source text).
    //   dest 'fe'          → move to FE/Bug, full populate (engTeam+domain option ids)
    //   dest 'cloud'       → move to CLOUD/Story, only unassign
    //   dest 'manual'      → open the Move screen, tell the user to finish manually
    //   dest 'deprecated'  → don't move; "no longer in use" banner + PSE tab
    //   dest 'unsupported' → don't move; "not supported yet" banner + PSE tab
    // Any value NOT listed here is treated as 'unsupported'. Blank → its own banner.
    ROUTES: {
      'DELIV - Delivery':                      { dest: 'fe', engTeam: '14341', domain: '15084' },
      'ECOINT - Ecosystem Integrations Squad': { dest: 'fe', engTeam: '14345', domain: '15078' },
      'ECOAPI - Ecosystem Partner API Squad':  { dest: 'fe', engTeam: '14345', domain: '15078' },
      'EE - Employee Experience':              { dest: 'fe', engTeam: '14343', domain: '15079' },
      'EEA - Employee Experience Assistant':   { dest: 'fe', engTeam: '14343', domain: '15079' }, // same as EE
      'GOV - Governance':                      { dest: 'fe', engTeam: '14342', domain: '15081' },
      'INT - Intelligence':                    { dest: 'fe', engTeam: '14681', domain: '15082' },
      'PUB - Publisher':                       { dest: 'fe', engTeam: '14340', domain: '15077' },
      'Operations':                            { dest: 'cloud' },
      // EEM: type depends on the source Bug field (see startFromIssue). Maps to
      // ENG Team "Experience - Mobile" (14486) + Domain "Mobile" (15083).
      'EEM - Employee Experience Mobile':      { dest: 'eem', engTeam: '14486', domain: '15083' },
      'PLT - Platform':                        { dest: 'deprecated', message: 'The PLT - Platform option is no longer valid as that team no longer exists. Please update it and try again.' },
      'Infosec':                               { dest: 'unsupported', message: 'This tool doesn’t support the Infosec CSUP domain as it may not be used anymore. Please either move manually or change the domain.' },
    },
    SUPPORTED_HINT: 'Supported: DELIV, EE, EEA, GOV, INT, PUB, ECOINT, ECOAPI, Operations.',
    MSG_MANUAL: "Sorry — we haven't fully enabled mobile support yet. Please proceed manually.",
    MSG_DEPRECATED: 'That Primary Engineering Domain Team value is no longer in use. Please update it and try again.',
    MSG_BLANK: 'Please set the Primary Engineering Domain Team first so that Auto-Move can route to the right project/type and map the Team/Domain fields correctly.',
    MSG_BUG_BLANK: 'For Mobile CSUPs, please select the Bug value first to ensure routing to the correct FE issue type (Non-Deploy or Bug).',
    // unsupported message is a function of the value:
    msgUnsupported: (t) => 'Auto-Move doesn’t support the Primary Engineering Domain Team value "' + t + '" as it didn’t exist when this tool was created. Please contact Carl so that he can add support for it, and in the meantime please move manually.',
    MSG_UNSUPPORTED_TYPE: 'Auto-Move only supports “Customer Issue - Firstup” CSUPs. This is a “Customer Issue - Dynamic” (Signal) ticket, which isn’t supported — please handle the move manually.',
  };

  const SRC_KEY = 'feAutoMove.sourceKey';   // source CSUP key, captured at kickoff
  const SRC_DATA = 'feAutoMove.srcData';    // {assigneeId, team} captured at kickoff
  const ROUTE_KEY = 'feAutoMove.route';     // resolved route {dest, project, type, engTeam, domain}
  const MANUAL_KEY = 'feAutoMove.manualMsg';// one-shot: message to show on the Move screen (EEM)
  const MOVED_KEY = 'feAutoMove.justMoved'; // one-shot: run post-move population
  const DONE_KEY = 'feAutoMove.done';       // one-shot: after the reload, show confirm + reminder
  const PSE_KEY = 'feAutoMove.pseComments'; // captured PSE comments awaiting review
  const SETTLING = 'feAutoMove.settling';   // set during post-move populate+reload; suppresses the PSE panel until settled

  const FLAG = 'feAutoMove.active'; // sessionStorage flag that keeps it going across reloads

  /* ===================== Jira REST (same-origin, cookie auth) ===================== */
  // Verified live: cookie auth + X-Atlassian-Token:no-check writes succeed as the
  // logged-in user. Runs in the user's own browser (no Claude classifier here).
  async function jiraGet(path) {
    const r = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('GET ' + path + ' → HTTP ' + r.status);
    return r.json();
  }
  async function jiraPut(path, body) {
    const r = await fetch(path, {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Atlassian-Token': 'no-check' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('PUT ' + path + ' → HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return true;
  }

  /* ===================== small helpers ===================== */

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const has = (hay, needle) => norm(hay).includes(norm(needle));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);

  // ---- breadcrumb trail (diagnostics) ----
  // A rolling log of what Auto-Move did and why it bailed, so a "silent" run
  // (e.g. a trigger that no-ops because the page wasn't ready) still leaves a
  // trace. Exposed as window.__feAutoMoveTrail and folded into the failure
  // snapshot. Pure logging — never affects control flow.
  const T0 = Date.now();
  const TRAIL = [];
  function trail(msg) {
    const e = { t: Date.now() - T0, msg };
    TRAIL.push(e);
    if (TRAIL.length > 60) TRAIL.shift();
    try { window.__feAutoMoveTrail = TRAIL; } catch (_) { /* ignore */ }
    try { console.debug('[FE AutoMove] ·', e.t + 'ms', msg); } catch (_) { /* ignore */ }
  }

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

  let badge, badgeMsg, badgeHint;
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
      badgeMsg = document.createElement('div');
      badgeHint = document.createElement('div');
      badgeHint.style.cssText = 'margin-top:5px; font-size:11.5px; opacity:.92;';
      badge.appendChild(badgeMsg);
      badge.appendChild(badgeHint);
      document.body.appendChild(badge);
    }
    badge.style.background = kind === 'error' ? '#bf2600' : kind === 'done' ? '#006644' : '#0052cc';
    badgeMsg.textContent = 'Auto-Move: ' + msg;
    // While a move is actively running (info state), remind the user not to switch
    // tabs — browsers throttle background tabs and block focus on inactive docs,
    // which can stall this timer-driven, multi-step wizard.
    badgeHint.textContent = (kind === 'info') ? '⚠ Keep this tab open and focused until it finishes.' : '';
    badgeHint.style.display = badgeHint.textContent ? 'block' : 'none';
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
      trail: TRAIL.slice(-40),
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
    trail('FAIL: ' + (err && err.message));
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
    const route = JSON.parse(sessionStorage.getItem(ROUTE_KEY) || '{}');
    const project = route.project || CFG.FE_PROJECT;
    const type = route.type || CFG.FE_TYPE;
    status('Setting project → ' + project);
    await setAuiPicker('project-field', 'project-suggestions', project);
    await sleep(600); // issue-type list repopulates after project changes
    status('Setting issue type → ' + type);
    await setAuiPicker('issuetype-field', 'issuetype-suggestions', type);
    // sanity check the hidden values before submitting
    const pOk = has($('#project-field')?.value, project);
    const tOk = has($('#issuetype-field')?.value, type);
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
    // Stamp Original Ticket = source CSUP key (the cleanup flow's marker).
    if (CFG.STAMP_ORIGINAL_TICKET) {
      const src = sessionStorage.getItem(SRC_KEY);
      const ot = document.getElementById(CFG.ORIGINAL_TICKET_FIELD_ID);
      if (src && ot) {
        ot.value = src;
        ['input', 'change'].forEach((t) => ot.dispatchEvent(new Event(t, { bubbles: true })));
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
    if (CFG.POST_MOVE_BANNER) sessionStorage.setItem(MOVED_KEY, '1'); // banner on destination
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

  // Resolve the destination + behavior for a Primary Engineering Domain Team value.
  function resolveRoute(team) {
    if (!team) return { dest: 'blank' };
    const r = CFG.ROUTES[team];
    if (!r) return { dest: 'unsupported', team };
    if (r.dest === 'fe') return { dest: 'fe', project: CFG.FE_PROJECT, type: CFG.FE_TYPE, engTeam: r.engTeam, domain: r.domain };
    if (r.dest === 'cloud') return { dest: 'cloud', project: CFG.CLOUD_PROJECT, type: CFG.CLOUD_TYPE };
    if (r.dest === 'eem') return { dest: 'eem', engTeam: r.engTeam, domain: r.domain }; // type decided from the Bug field
    return { dest: r.dest, team, message: r.message }; // manual / deprecated / unsupported (message optional)
  }

  // Best-effort: switch the issue view to the PSE tab (where the team field lives).
  // NB: there are TWO "PSE" role=tab nodes — a "spotlight" onboarding duplicate
  // (no data-testid, appears first) and the real tab. Target the real one, and
  // dispatch a full pointer/mouse sequence (plain .click() doesn't flip it).
  function openPseTab() {
    const tabs = [...document.querySelectorAll('[role="tab"]')].filter((t) => (t.textContent || '').trim() === 'PSE');
    const tab = tabs.find((t) => (t.getAttribute('data-testid') || '').startsWith('issue-view-layout-templates-tab-')) ||
                tabs.find((t) => !(t.id || '').includes('spotlight')) || tabs[0];
    if (!tab) return;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
      const Ev = (typeof PointerEvent !== 'undefined' && type.startsWith('pointer')) ? PointerEvent : MouseEvent;
      tab.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, view: window }));
    });
  }

  // Open Actions → Move (navigates to the wizard). Does NOT set FLAG — the caller
  // decides whether the wizard should be auto-driven.
  async function openMove() {
    status('Opening Actions menu…');
    const trigger = await waitFor(() =>
      $('[data-testid="issue-meatball-menu.ui.dropdown-trigger.button"]'));
    trigger.click();
    const move = await waitFor(() =>
      $('[data-testid="issue-view-foundation.issue-actions.issue-manipulation-dropdown-group.move-issue.styled-section-move-issue"]') ||
      [...document.querySelectorAll('[role="menuitem"]')].find((m) => norm(m.textContent) === 'move'));
    status('Opening Move…');
    trail('openMove: clicking Move (navigating to wizard)');
    move.click(); // navigates to /secure/MoveIssue!default.jspa
  }

  // Wipe all cross-page state so a new kickoff never inherits a stale FLAG/route
  // from a prior or aborted run (which could otherwise drive a stray move).
  function clearState() {
    [SRC_KEY, SRC_DATA, ROUTE_KEY, MANUAL_KEY, MOVED_KEY, DONE_KEY, PSE_KEY, SETTLING, FLAG]
      .forEach((k) => sessionStorage.removeItem(k));
  }

  async function startFromIssue() {
    trail('startFromIssue: begin');
    clearState(); // fresh start every time
    const srcKey = currentIssueKey();
    if (!srcKey) {
      trail('startFromIssue: no issue key (page not ready?)');
      showBanner('The page is still loading — give it a second and try Auto-Move again.', 'error');
      return;
    }

    // Read assignee + Primary Engineering Domain Team (drives routing; may not
    // survive the move, so we capture it now while still on the CSUP issue).
    let src = { assigneeId: null, team: null, bug: null, customerImpact: null };
    try {
      const d = await jiraGet('/rest/api/3/issue/' + srcKey + '?fields=assignee,issuetype,' + CFG.SOURCE_TEAM_FIELD_ID + ',' + CFG.BUG_FIELD_ID + ',' + CFG.CUSTOMER_IMPACT_FIELD_ID);
      // Authoritative issue-type gate (the button-hide is best-effort/DOM-based;
      // this catches a hotkey press or a type the DOM check missed).
      const itype = d.fields.issuetype && d.fields.issuetype.name;
      if (itype && CFG.UNSUPPORTED_TYPE_NAMES.indexOf(itype) !== -1) {
        trail('startFromIssue: unsupported issue type — ' + itype);
        showBanner(CFG.MSG_UNSUPPORTED_TYPE, 'error', true);
        return;
      }
      const team = d.fields[CFG.SOURCE_TEAM_FIELD_ID];
      const bug = d.fields[CFG.BUG_FIELD_ID];
      const ci = d.fields[CFG.CUSTOMER_IMPACT_FIELD_ID];
      src = {
        assigneeId: d.fields.assignee ? d.fields.assignee.accountId : null,
        team: team ? (team.value !== undefined ? team.value : team.name) : null,
        bug: bug ? (bug.value !== undefined ? bug.value : bug.name) : null,
        customerImpact: ci ? (ci.value !== undefined ? ci.value : ci.name) : null,
      };
    } catch (e) { trail('startFromIssue: read failed — ' + e.message); showBanner('Could not read this issue: ' + e.message, 'error', true); return; }

    let route = resolveRoute(src.team);
    trail('route=' + (route && route.dest) + ' team=' + (src.team || '∅') + ' key=' + srcKey);

    // EEM/mobile: the destination issue type is decided by the source Bug field.
    if (route.dest === 'eem') {
      const bug = (src.bug || '').toString().trim().toLowerCase();
      if (!bug) { showBanner(CFG.MSG_BUG_BLANK, 'error', true); openPseTab(); return; }
      const type = (bug === 'yes' || bug === 'tbd') ? CFG.FE_TYPE : CFG.NON_DEPLOY_TYPE; // Yes / TBD → Bug ; No → Non-Deploy
      route = { dest: 'fe', project: CFG.FE_PROJECT, type: type, engTeam: route.engTeam, domain: route.domain };
    }

    // Block cases — no move; guidance banner (+ PSE tab so they can fix the field).
    if (route.dest === 'blank') { showBanner(CFG.MSG_BLANK, 'error', true); openPseTab(); return; }
    if (route.dest === 'deprecated') { showBanner(route.message || CFG.MSG_DEPRECATED, 'error', true); openPseTab(); return; }
    if (route.dest === 'unsupported') { showBanner(route.message || CFG.msgUnsupported(src.team), 'error', true); openPseTab(); return; }

    // Required-before-move gate (FE-bound routes): Bug + Customer Impact must be
    // set on the CSUP first. Previously these were nagged about after the move.
    if (route.dest === 'fe') {
      const missing = (CFG.REQUIRED_BEFORE_MOVE || []).filter((f) => !src[f.srcKey]).map((f) => f.label);
      if (missing.length) {
        trail('blocked: required-before-move missing — ' + missing.join(', '));
        showBanner('Please set ' + missing.join(' and ') + ' on the CSUP before moving, then run Auto-Move again.', 'error', true);
        openPseTab(); // these are PSE-tab fields — jump the user there to fill them in
        return;
      }
    }

    // Proceeding cases — stash context that the wizard/post-move steps need.
    sessionStorage.setItem(SRC_KEY, srcKey);
    sessionStorage.setItem(SRC_DATA, JSON.stringify(src));

    if (route.dest === 'manual') {
      // Open the Move screen but don't auto-drive; show the message there.
      sessionStorage.setItem(MANUAL_KEY, CFG.MSG_MANUAL);
      await openMove();
      return;
    }

    // Capture PSE-restricted comments now (they vanish on move) for post-move
    // review → PSE Notes. FE route only (that's where PSE Notes lives).
    if (CFG.HANDLE_PSE_COMMENTS && route.dest === 'fe') {
      try {
        const cr = await jiraGet('/rest/api/3/issue/' + srcKey + '/comment?maxResults=100');
        const pse = (cr.comments || [])
          .filter((c) => c.visibility && (c.visibility.value === CFG.PSE_ROLE_NAME || c.visibility.identifier === CFG.PSE_ROLE_NAME))
          .map((c) => ({ author: c.author && c.author.displayName, created: c.created, body: c.body }));
        if (pse.length) sessionStorage.setItem(PSE_KEY, JSON.stringify(pse));
      } catch (e) { console.warn('[FE AutoMove] PSE comment capture failed:', e.message); }
    }

    // fe / cloud — auto-drive the wizard using the resolved route.
    sessionStorage.setItem(ROUTE_KEY, JSON.stringify(route));
    sessionStorage.setItem(FLAG, '1');
    await openMove();
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

  // The current issue's type name, read synchronously from the issue view (the
  // type button's aria-label / its icon's alt). Null if not rendered yet.
  // Verified live: "Customer Issue - Firstup" vs "Customer Issue - Dynamic".
  function currentIssueType() {
    const el = document.querySelector('[data-testid*="issue-type.button"]') ||
               document.querySelector('[data-testid*="issue-type"] img[alt]');
    if (!el) return null;
    return (el.getAttribute('aria-label') || el.getAttribute('alt') || '').trim() || null;
  }

  // True when the current issue's type is one Auto-Move doesn't support (e.g.
  // "Customer Issue - Dynamic"). Only positive when we can actually read the
  // type — an unread type never hides the button on a normal Firstup ticket.
  function onUnsupportedType() {
    const t = currentIssueType();
    return !!t && CFG.UNSUPPORTED_TYPE_NAMES.indexOf(t) !== -1;
  }

  // Only show/fire on a <SOURCE_PREFIX> issue (the move is CSUP → FE). Excludes
  // the wizard, non-CSUP issues (e.g. an already-moved FE ticket), and CSUP
  // issue types we don't support (Dynamic).
  function onCsupIssue() {
    if (onWizard()) return false;
    const key = currentIssueKey();
    if (!key || !key.toUpperCase().startsWith((CFG.SOURCE_PREFIX + '-').toUpperCase())) return false;
    if (onUnsupportedType()) return false; // hide the button on Dynamic etc.
    return true;
  }

  function injectStartButton() {
    const b = document.createElement('button');
    b.id = 'fe-automove-btn';
    b.textContent = '⤷ Auto-Move';
    Object.assign(b.style, {
      position: 'fixed', bottom: '16px', left: '16px', zIndex: 2147483647,
      background: '#0052cc', color: '#fff', border: 'none', borderRadius: '6px',
      padding: '10px 14px', font: '13px -apple-system,system-ui,sans-serif',
      cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,.25)',
    });
    if (CFG.HOTKEY) b.title = 'Keyboard shortcut: ' + CFG.HOTKEY;
    b.addEventListener('click', () => { trail('button click'); startFromIssue().catch(fail); });
    document.body.appendChild(b);
  }

  // Show the button on a CSUP issue; remove it otherwise (idempotent).
  function updateButton() {
    const existing = document.getElementById('fe-automove-btn');
    if (onCsupIssue()) { if (!existing) injectStartButton(); }
    else if (existing) existing.remove();
  }

  // Top-center banner. kind: 'working'|'done'|'error'. 'working' persists;
  // 'done'/'error' auto-hide after 15s unless persist=true (then a ✕ is shown).
  function showBanner(msg, kind, persist) {
    const old = document.getElementById('fe-automove-banner');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'fe-automove-banner';
    Object.assign(el.style, {
      position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
      zIndex: 2147483647, color: '#fff', font: '13px/1.45 -apple-system,system-ui,sans-serif',
      padding: '10px 16px', borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,.3)',
      maxWidth: '560px', textAlign: 'center',
    });
    el.style.background = kind === 'error' ? '#bf2600' : kind === 'working' ? '#0052cc' : '#006644';
    const span = document.createElement('span');
    span.textContent = msg;
    el.appendChild(span);
    if (persist) {
      const x = document.createElement('button');
      x.textContent = '✕';
      Object.assign(x.style, { marginLeft: '12px', cursor: 'pointer', background: 'transparent', border: 'none', color: '#fff', fontWeight: '700', font: '13px sans-serif' });
      x.addEventListener('click', () => el.remove());
      el.appendChild(x);
    }
    document.body.appendChild(el);
    if (kind !== 'working' && !persist) setTimeout(() => el && el.remove(), 15000);
  }

  // Populate the destination FE Bug via REST: constants + mapped Domain/ENG Team
  // (one PUT), then reporter/unassign (separate PUT so a reporter failure can't
  // block the field writes). Returns the list of what was set.
  // Reporter to use for the destination issue: the CSUP's previous assignee, or
  // (if it had none and the fallback is enabled) whoever is running Auto-Move.
  async function resolveReporterId(assigneeId) {
    if (assigneeId) return { id: assigneeId, isFallback: false };
    if (!CFG.REPORTER_FALLBACK_TO_SELF) return { id: null, isFallback: false };
    const me = await currentAccountId();
    return { id: me, isFallback: !!me };
  }

  async function populateFields(feKey, route) {
    trail('populateFields: ' + feKey + ' (' + (route && route.dest) + ')');
    const src = JSON.parse(sessionStorage.getItem(SRC_DATA) || '{}');
    const done = [];
    const reporter = await resolveReporterId(src.assigneeId);
    if (reporter.isFallback) trail('populateFields: CSUP had no assignee — Reporter falling back to self');

    // CLOUD/Operations route: set Reporter to the previous assignee (or self, if
    // the CSUP had none), then unassign (IT granted the Reporter permission on
    // Cloud Operations as of v3.10).
    if (route.dest === 'cloud') {
      if (CFG.REASSIGN && reporter.id) {
        await jiraPut('/rest/api/3/issue/' + feKey, { fields: { reporter: { accountId: reporter.id }, assignee: null } });
        done.push(reporter.isFallback ? 'reporter(self)/unassign' : 'reporter/unassign');
      } else {
        await jiraPut('/rest/api/3/issue/' + feKey, { fields: { assignee: null } });
        done.push('unassign');
      }
      return done;
    }

    // FE route: constants + mapped Domain/ENG Team (one PUT), then reporter/unassign.
    const fields = {};
    for (const [fid, optId] of Object.entries(CFG.CONST_FIELDS || {})) fields[fid] = { id: optId };
    if (Object.keys(fields).length) done.push('constants');
    if (route.engTeam && route.domain) {
      fields[CFG.DOMAIN_FIELD_ID] = { id: route.domain };
      fields[CFG.ENG_TEAM_FIELD_ID] = { id: route.engTeam };
      done.push('Domain/ENG Team');
    }
    if (Object.keys(fields).length) await jiraPut('/rest/api/3/issue/' + feKey, { fields });
    if (CFG.REASSIGN && reporter.id) {
      await jiraPut('/rest/api/3/issue/' + feKey, {
        fields: { reporter: { accountId: reporter.id }, assignee: null },
      });
      done.push(reporter.isFallback ? 'reporter(self)/unassign' : 'reporter/unassign');
    }
    // Best-effort: copy the Description ADF into the "CSUP ticket" field. Its own
    // PUT + try/catch so a rejection (or unexpected field config) never fails the
    // rest of the population. Same-issue copy → media/attachments still resolve.
    if (CFG.COPY_DESCRIPTION) {
      try {
        const iss = await jiraGet('/rest/api/3/issue/' + feKey + '?fields=description');
        const adf = iss.fields && iss.fields.description;
        if (adf) {
          await jiraPut('/rest/api/3/issue/' + feKey, { fields: { [CFG.CSUP_TICKET_FIELD_ID]: adf } });
          done.push('Description→CSUP ticket');
        }
      } catch (e) { console.warn('[FE AutoMove] description copy failed:', e.message); }
    }
    return done;
  }

  // Dismissable checklist banner listing fields the user still needs to set.
  function showReminder(labels) {
    const old = document.getElementById('fe-automove-reminder');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'fe-automove-reminder';
    Object.assign(el.style, {
      position: 'fixed', top: '64px', left: '50%', transform: 'translateX(-50%)',
      zIndex: 2147483647, background: '#172b4d', color: '#fff',
      font: '13px/1.5 -apple-system,system-ui,sans-serif', padding: '12px 16px',
      borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,.3)', maxWidth: '360px',
    });
    const title = document.createElement('div');
    title.textContent = 'Remember to set the following:';
    title.style.fontWeight = '600';
    title.style.marginBottom = '6px';
    el.appendChild(title);
    const ul = document.createElement('ul');
    ul.style.margin = '0'; ul.style.paddingLeft = '20px';
    labels.forEach((l) => { const li = document.createElement('li'); li.textContent = l; ul.appendChild(li); });
    el.appendChild(ul);
    const close = document.createElement('button');
    close.textContent = 'Dismiss';
    Object.assign(close.style, {
      marginTop: '10px', cursor: 'pointer', border: 'none', borderRadius: '5px',
      padding: '6px 10px', background: '#fff', color: '#172b4d', fontWeight: '600',
      font: '12px -apple-system,system-ui,sans-serif',
    });
    close.addEventListener('click', () => el.remove());
    el.appendChild(close);
    document.body.appendChild(el);
  }

  // Returns the labels of reminder fields that are still empty on the issue.
  async function emptyReminderLabels(feKey) {
    const fields = CFG.REMINDER_FIELDS || [];
    if (!fields.length) return [];
    let data;
    try {
      data = await jiraGet('/rest/api/3/issue/' + feKey + '?fields=' + fields.map((f) => f.id).join(','));
    } catch (e) { console.warn('[FE AutoMove] reminder check failed:', e.message); return []; }
    const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
    return fields.filter((f) => isEmpty(data.fields[f.id])).map((f) => f.label);
  }

  // One-shot after a completed move: populate the FE fields. On success, reload
  // so the new values actually render (Jira's view is stale post-write); the
  // confirmation + reminder are shown after the reload via DONE_KEY.
  function maybePostMoveBanner() {
    if (sessionStorage.getItem(MOVED_KEY) !== '1') return;
    if (onWizard()) return;                 // wait until we've left the wizard
    if (document.getElementById('fe-automove-banner')) return;
    const key = currentIssueKey();
    if (!key) return;                       // issue not resolved yet; retry next tick
    sessionStorage.removeItem(MOVED_KEY);   // fire once
    const route = JSON.parse(sessionStorage.getItem(ROUTE_KEY) || '{}');
    if (route.dest === 'moveback') {
      trail('move-back: landed on ' + key);
      showBanner('✅ Moved back to ' + key + ' (Customer Issue - Dynamic). Delete it when you’re done testing.', 'done');
      return; // no field populate / reminders / PSE panel on a move-back
    }
    if (!CFG.POPULATE_FIELDS) { showBanner('✅ Moved to ' + key + '.', 'done'); return; }
    showBanner('⏳ Moved to ' + key + ' — setting fields…', 'working');
    // Suppress the PSE panel until the populate + reload settle (else it flashes
    // on the pre-reload page). Set synchronously so this tick's maybePseReview skips.
    if (CFG.RELOAD_AFTER_POPULATE) sessionStorage.setItem(SETTLING, '1');
    populateFields(key, route)
      .then(async (d) => {
        const empties = (CFG.REMIND_EMPTY && route.dest === 'fe') ? await emptyReminderLabels(key) : [];
        if (CFG.RELOAD_AFTER_POPULATE) {
          sessionStorage.setItem(DONE_KEY, JSON.stringify({ key, set: d, empties }));
          location.reload(); // fetches fresh values; DONE_KEY re-shows the banners
          return;
        }
        showBanner('✅ ' + key + ' — fields set (' + (d.join(', ') || 'none') + ').', 'done');
        if (empties.length) showReminder(empties);
      })
      .catch((e) => {
        sessionStorage.removeItem(SETTLING); // no reload happened → let the PSE panel show
        showBanner('⚠️ ' + key + ' moved, but field update failed: ' + e.message +
          ' — set them manually.', 'error');
        console.error('[FE AutoMove] populate failed:', e);
      });
  }

  // After the post-populate reload, re-show the confirmation + reminder (once).
  function maybeShowDone() {
    const raw = sessionStorage.getItem(DONE_KEY);
    if (!raw) return;
    if (onWizard()) return;
    const key = currentIssueKey();
    if (!key) return;                       // wait for the reloaded issue to resolve
    sessionStorage.removeItem(DONE_KEY);    // fire once
    sessionStorage.removeItem(SETTLING);    // settled → the PSE panel may now show
    let info; try { info = JSON.parse(raw); } catch (e) { return; }
    showBanner('✅ ' + (info.key || key) + ' — fields set (' + ((info.set || []).join(', ') || 'none') + ').', 'done');
    if (info.empties && info.empties.length) showReminder(info.empties);
  }

  // EEM/manual route: once we've landed on the Move screen's project/type step,
  // show the "proceed manually" message (the wizard is NOT auto-driven here).
  function maybeManualMsg() {
    const msg = sessionStorage.getItem(MANUAL_KEY);
    if (!msg) return;
    if (detectStep() !== 'select') return; // wait for the project/type page
    sessionStorage.removeItem(MANUAL_KEY);  // fire once
    showBanner(msg, 'working', true);       // persistent info banner with a ✕
  }

  /* ===================== PSE comments → PSE Notes ===================== */

  const adfText = (n) => !n ? '' : (n.type === 'text' ? (n.text || '') : (n.content || []).map(adfText).join(''));

  // Append the selected captured comments into the PSE Notes field (preserving
  // existing content). Each gets a bold header line + the comment body + a rule.
  async function savePseComments(feKey, selected) {
    let existing = null;
    try {
      const iss = await jiraGet('/rest/api/3/issue/' + feKey + '?fields=' + CFG.PSE_NOTES_FIELD_ID);
      existing = iss.fields[CFG.PSE_NOTES_FIELD_ID];
    } catch (e) { /* treat as empty */ }
    const doc = (existing && existing.type === 'doc' && Array.isArray(existing.content))
      ? existing : { type: 'doc', version: 1, content: [] };
    selected.forEach((c) => {
      doc.content.push({ type: 'paragraph', content: [ { type: 'text',
        text: 'PSE comment — ' + (c.author || 'Unknown') + ' · ' + (c.created ? c.created.slice(0, 10) : ''),
        marks: [{ type: 'strong' }] } ] });
      if (c.body && Array.isArray(c.body.content)) doc.content.push(...c.body.content);
      doc.content.push({ type: 'rule' });
    });
    if (!doc.version) doc.version = 1;
    await jiraPut('/rest/api/3/issue/' + feKey, { fields: { [CFG.PSE_NOTES_FIELD_ID]: doc } });
  }

  // Checklist panel: pick which captured PSE comments to append into PSE Notes.
  function showPseReviewPanel(feKey, comments) {
    const el = document.createElement('div');
    el.id = 'fe-automove-pse';
    Object.assign(el.style, {
      position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)',
      zIndex: 2147483647, background: '#172b4d', color: '#fff',
      font: '13px/1.45 -apple-system,system-ui,sans-serif', padding: '14px 16px',
      borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,.35)', maxWidth: '460px',
      maxHeight: '60vh', overflowY: 'auto',
    });
    const title = document.createElement('div');
    title.textContent = 'PSE comments from the original ticket — tick which to copy into PSE Notes:';
    title.style.fontWeight = '600'; title.style.marginBottom = '10px';
    el.appendChild(title);
    const boxes = [];
    comments.forEach((c) => {
      const row = document.createElement('label');
      Object.assign(row.style, { display: 'block', margin: '0 0 10px', cursor: 'pointer' });
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.style.marginRight = '8px'; // default UNCHECKED (opt-in, avoids saving sensitive ones by accident)
      boxes.push(cb);
      const meta = document.createElement('span');
      meta.style.fontWeight = '600';
      meta.textContent = (c.author || 'Unknown') + ' · ' + (c.created ? c.created.slice(0, 10) : '');
      const prev = document.createElement('div');
      Object.assign(prev.style, { opacity: '0.85', marginTop: '2px', marginLeft: '22px', whiteSpace: 'pre-wrap' });
      const text = (c.body && Array.isArray(c.body.content)) ? c.body.content.map(adfText).join('\n') : '';
      prev.textContent = text.slice(0, 240) + (text.length > 240 ? '…' : '');
      row.appendChild(cb); row.appendChild(meta); row.appendChild(prev);
      el.appendChild(row);
    });
    const mk = (label, bg, fg, onClick) => {
      const b = document.createElement('button');
      b.textContent = label;
      Object.assign(b.style, { cursor: 'pointer', border: 'none', borderRadius: '5px', padding: '7px 10px', marginRight: '8px', background: bg, color: fg, fontWeight: '600', font: '12px -apple-system,system-ui,sans-serif' });
      b.addEventListener('click', onClick);
      return b;
    };
    const save = mk('Save selected to PSE Notes', '#fff', '#172b4d', async () => {
      const selected = comments.filter((_, i) => boxes[i].checked);
      if (!selected.length) { el.remove(); sessionStorage.removeItem(PSE_KEY); return; }
      save.disabled = true; save.textContent = 'Saving…';
      try {
        await savePseComments(feKey, selected);
        el.remove(); sessionStorage.removeItem(PSE_KEY);
        if (CFG.RELOAD_AFTER_PSE_SAVE) {
          showBanner('✅ Saved ' + selected.length + ' PSE comment(s) — refreshing to show them…', 'working');
          setTimeout(() => location.reload(), 700);
        } else {
          showBanner('✅ Saved ' + selected.length + ' PSE comment(s) to PSE Notes.', 'done');
        }
      } catch (e) {
        save.disabled = false; save.textContent = 'Save selected to PSE Notes';
        showBanner('⚠️ Could not save to PSE Notes: ' + e.message, 'error', true);
      }
    });
    const dismiss = mk('Dismiss', 'transparent', '#fff', () => { el.remove(); sessionStorage.removeItem(PSE_KEY); });
    dismiss.style.border = '1px solid rgba(255,255,255,.5)';
    const bar = document.createElement('div'); bar.style.marginTop = '6px';
    bar.appendChild(save); bar.appendChild(dismiss);
    el.appendChild(bar);
    document.body.appendChild(el);
  }

  // After the move, if PSE comments were captured, show the review panel (once).
  function maybePseReview() {
    if (!CFG.HANDLE_PSE_COMMENTS) return;
    const raw = sessionStorage.getItem(PSE_KEY);
    if (!raw) return;
    if (onWizard()) return;
    if (onCsupIssue()) return;              // only on the destination, never the source
    if (sessionStorage.getItem(SETTLING)) return; // wait for the populate+reload to settle
    if (document.getElementById('fe-automove-pse')) return; // already shown
    if (!currentIssueKey()) return;
    let comments; try { comments = JSON.parse(raw); } catch (e) { sessionStorage.removeItem(PSE_KEY); return; }
    if (!Array.isArray(comments) || !comments.length) { sessionStorage.removeItem(PSE_KEY); return; }
    showPseReviewPanel(currentIssueKey(), comments);
  }

  /* ===================== main dispatcher ===================== */

  let running = false; // guards the wizard step handlers against re-entry
  async function runStep(step) {
    if (running) return;
    running = true; // stays set for this page load; a full reload resets it
    trail('wizard step: ' + step);
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
    const step = detectStep();
    const active = sessionStorage.getItem(FLAG) === '1';
    const hasRoute = !!sessionStorage.getItem(ROUTE_KEY);
    // Only auto-drive the wizard when BOTH the active flag AND a resolved route
    // are present. A stale FLAG with no route (leftover from an aborted run) is
    // cleared instead of defaulting to an FE move.
    if (step && active && hasRoute) { runStep(step); return; }
    if (active && !hasRoute) sessionStorage.removeItem(FLAG);
    updateButton();
    maybePostMoveBanner();
    maybeShowDone();
    maybeManualMsg();
    maybePseReview();
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

  trail('init v3.21 @ ' + location.pathname);
  window.addEventListener('load', () => setTimeout(tick, 400));
  setTimeout(tick, 600);

  // If the user switches away while a move is running, record it — browsers throttle
  // background tabs (and deny focus to inactive docs), which can stall the wizard.
  // This breadcrumb makes that visible in a failure report; the status badge also
  // warns the user to stay put while it runs.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && sessionStorage.getItem(FLAG) === '1') {
      trail('⚠ tab backgrounded during active move (step=' + detectStep() + ') — may stall');
    }
  });

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
      if (isEditable(document.activeElement)) { trail('hotkey ignored: typing in a field'); return; } // not while typing
      if (!onCsupIssue()) {
        // The combo matched but this isn't a supported, ready CSUP issue.
        // Unsupported type (Dynamic) → say so; otherwise, if it looks like a CSUP
        // that just hasn't rendered → "still loading"; else stay quiet (the
        // hotkey is global and may be pressed on unrelated pages).
        if (onUnsupportedType()) {
          trail('hotkey ignored: unsupported issue type — ' + currentIssueType());
          showBanner(CFG.MSG_UNSUPPORTED_TYPE, 'error', true);
          return;
        }
        const looksCsup = new RegExp('(/browse/|\\[)' + CFG.SOURCE_PREFIX + '-\\d+', 'i')
          .test(location.href + ' ' + (document.title || ''));
        trail('hotkey ignored: not a ready CSUP issue' + (looksCsup ? ' (looks CSUP — still loading?)' : ''));
        if (looksCsup) showBanner('The page is still loading — give it a second and try Auto-Move again.', 'error');
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      trail('hotkey fire');
      startFromIssue().catch(fail);
    }, true);
  }

  /* ===================== Move Back (private cleanup) ===================== */
  // Reverse an already-moved FE issue back to a CSUP (as Customer Issue - Dynamic)
  // so it can be re-tested / cleaned up. Account-gated → invisible to everyone else.
  let _acctId; // cached current-user accountId (lazy)
  async function currentAccountId() {
    if (_acctId !== undefined) return _acctId;
    try { const m = await jiraGet('/rest/api/3/myself'); _acctId = m.accountId; }
    catch (e) { _acctId = null; }
    return _acctId;
  }

  function onFeIssue() {
    if (onWizard()) return false;
    const k = currentIssueKey();
    return !!k && k.toUpperCase().startsWith('FE-');
  }

  // Dedicated interactive confirm banner (the status/error banners aren't clickable).
  function showMoveBackConfirm(key) {
    const old = document.getElementById('fe-automove-moveback');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'fe-automove-moveback';
    Object.assign(el.style, {
      position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
      zIndex: 2147483647, color: '#fff', font: '13px/1.45 -apple-system,system-ui,sans-serif',
      background: '#172b4d', padding: '12px 16px', borderRadius: '8px',
      boxShadow: '0 4px 16px rgba(0,0,0,.35)', maxWidth: '520px', textAlign: 'center',
    });
    const msg = document.createElement('div');
    msg.textContent = CFG.msgMoveBackConfirm(key);
    msg.style.marginBottom = '10px';
    el.appendChild(msg);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px; justify-content:center;';
    const mk = (label, bg, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'border:none; border-radius:6px; padding:7px 14px; cursor:pointer; color:#fff;' +
        'font:13px -apple-system,system-ui,sans-serif; background:' + bg + ';';
      b.addEventListener('click', fn);
      return b;
    };
    row.appendChild(mk('Move back', '#bf2600', () => { el.remove(); startMoveBack(); }));
    row.appendChild(mk('Cancel', '#5e6c84', () => el.remove()));
    el.appendChild(row);
    document.body.appendChild(el);
  }

  function startMoveBack() {
    clearState(); // fresh state, then set up the reverse route
    sessionStorage.setItem(ROUTE_KEY, JSON.stringify({
      dest: 'moveback', project: CFG.MOVE_BACK_PROJECT, type: CFG.MOVE_BACK_TYPE,
    }));
    sessionStorage.setItem(FLAG, '1'); // let the wizard driver auto-run the steps
    trail('move-back: kickoff → ' + CFG.MOVE_BACK_PROJECT + ' / ' + CFG.MOVE_BACK_TYPE);
    openMove().catch(fail);
  }

  const MOVE_BACK_HOTKEY = parseHotkey(CFG.MOVE_BACK_HOTKEY);
  if (CFG.MOVE_BACK_ENABLED && MOVE_BACK_HOTKEY) {
    window.addEventListener('keydown', async (e) => {
      if (e.repeat) return;
      if (e.ctrlKey !== MOVE_BACK_HOTKEY.ctrl || e.shiftKey !== MOVE_BACK_HOTKEY.shift ||
          e.altKey !== MOVE_BACK_HOTKEY.alt || e.metaKey !== MOVE_BACK_HOTKEY.meta) return;
      if ((e.key || '').toLowerCase() !== MOVE_BACK_HOTKEY.key) return;
      if (isEditable(document.activeElement)) return; // not while typing
      if (!onFeIssue()) return;                        // only on FE issues; silent elsewhere
      const acct = await currentAccountId();
      if (!acct || CFG.MOVE_BACK_ACCOUNT_IDS.indexOf(acct) === -1) return; // not for this user → silent
      e.preventDefault();
      e.stopPropagation();
      trail('move-back hotkey fire on ' + currentIssueKey());
      showMoveBackConfirm(currentIssueKey());
    }, true);
  }
})();
