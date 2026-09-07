/* ==========================================================================
   lease-asset-dashboard.js
   Page controller for the Lease Asset Dashboard.

   IMPORTANT — read before wiring this into the real app:

   library.js already contains getApiBaseUrl() / getAuthHeadersFromStorage()
   / fetchApiJson(), but they are private to that file's own IIFE and are
   NOT exposed on window.QafLibrary or window.GridTable. There is also no
   RNSP call anywhere in library.js to call instead. So the RNSP helper
   below (callRnsp) is a NEW small addition — not a "second competing API
   helper" replacing an existing one, but the one that had to be written
   because none exists yet — and it deliberately mirrors library.js's
   private conventions byte-for-byte (same base-url priority, the exact
   same "user_key" auth-header shape) so it behaves identically to the
   rest of the app rather than introducing a divergent pattern. If/when
   these helpers get exported from library.js, callRnsp/getApiBaseUrl/
   getAuthHeadersFromStorage below should be deleted in favor of calling
   the shared versions directly.

   Base URL resolution mirrors getApiBaseUrl()'s own priority order
   (window.APP_ENV.API_BASE_URL first), but swaps its hardcoded
   "https://ndem.quickappflow.com" fallback for localStorage.getItem('env')
   — the key actually observed holding this same URL in the live app's
   storage — since the spec requires localStorage, not a hardcoded domain.
   If your bootstrap uses a different key, change BASE_URL_STORAGE_KEY
   below; everything else keys off that one constant.
   ========================================================================== */

(function () {
  'use strict';

  var BASE_URL_STORAGE_KEY = 'env'; // <-- confirm/adjust against the real app if different

  var WORKFLOWS = {
    summary: 'SummaryCard_Wise_Lease_Assets',
    statusMix: 'LeaseStatusMix_Wise_Lease_Assets',
    ageing: 'LeaseAgeing_Wise_Lease_Assets',
    renewals: 'LeaseAssetRenewals_Wise_Lease_Assets',
    department: 'Department_Wise_Lease_Assets',
    location: 'Location_Wise_Lease_Assets'
  };
  var FILTER_VALUES_WORKFLOW = 'ASSET_VALUE_FILTER';

  // ------------------------------------------------------------------
  // Base URL + auth (mirrors library.js's private getApiBaseUrl /
  // getAuthHeadersFromStorage — see file header note above).
  // ------------------------------------------------------------------

  function getApiBaseUrl() {
    var envGlobal = window.APP_ENV && window.APP_ENV.API_BASE_URL;
    if (envGlobal) {
      var resolved = String(envGlobal).trim().replace(/\/+$/, '');
      console.debug('[lease-dashboard] base URL from window.APP_ENV.API_BASE_URL:', resolved);
      return resolved;
    }
    try {
      var stored = window.localStorage && window.localStorage.getItem(BASE_URL_STORAGE_KEY);
      if (stored) {
        var cleaned = String(stored).trim().replace(/^"+|"+$/g, '').replace(/\/+$/, '');
        console.debug('[lease-dashboard] base URL from localStorage["' + BASE_URL_STORAGE_KEY + '"]:', cleaned);
        return cleaned;
      }
    } catch (e) {
      console.warn('[lease-dashboard] could not read base URL from localStorage:', e);
    }
    console.warn('[lease-dashboard] no base URL found — checked window.APP_ENV.API_BASE_URL and localStorage["' + BASE_URL_STORAGE_KEY + '"]. RNSP calls will fail until one is set.');
    return '';
  }

  function getAuthHeadersFromStorage() {
    function tryParseJson(input) {
      try { return JSON.parse(input); } catch (e) { return null; }
    }
    var parsed = tryParseJson((window.localStorage && window.localStorage.getItem('user_key')) || '');
    var parsedValue = parsed && typeof parsed.value === 'string' ? tryParseJson(parsed.value) : (parsed && parsed.value);
    var payload = (parsedValue && typeof parsedValue === 'object' && parsedValue) ||
      (parsed && typeof parsed === 'object' && parsed) || {};
    return {
      'Content-Type': 'application/json',
      employeeguid: payload.employeeguid || payload.EmployeeGUID || '',
      hrzemail: payload.hrzemail || payload.Email || '',
      hrzempid: payload.hrzempid || payload.EmployeeID || '',
      lngs: payload.lngs || 'Asia/Kolkata'
    };
  }

  /**
   * Calls the RNSP endpoint exactly as specified: {baseUrl}/api/rnsp with
   * { Name, Args }. Throws a descriptive, workflow-attributed Error on any
   * failure so a caller can tell which of the six workflows broke.
   */
  async function callRnsp(name, args) {
    var base = getApiBaseUrl();
    if (!base) {
      throw new Error('No API base URL configured (checked window.APP_ENV.API_BASE_URL and localStorage["' + BASE_URL_STORAGE_KEY + '"]).');
    }
    var url = base + '/api/rnsp';
    var body = { Name: name, Args: args || {} };
    console.debug('[lease-dashboard] → RNSP', name, url, body);
    var response;
    try {
      response = await window.fetch(url, {
        method: 'POST',
        headers: getAuthHeadersFromStorage(),
        body: JSON.stringify(body)
      });
    } catch (networkErr) {
      // Typically CORS, a wrong/unreachable base URL, or the page being
      // served over http(s) while `url` resolves to the other scheme.
      throw new Error('[' + name + '] network error calling RNSP at ' + url + ': ' + networkErr.message);
    }
    if (!response || !response.ok) {
      var errText = '';
      try { errText = await response.text(); } catch (e2) { /* noop */ }
      throw new Error('[' + name + '] RNSP call failed (' + (response ? response.status : 'no response') + ') ' + errText.slice(0, 200));
    }
    var text = await response.text();
    console.debug('[lease-dashboard] ← RNSP', name, text.slice(0, 500));
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('[' + name + '] RNSP response was not valid JSON: ' + text.slice(0, 200));
    }
  }

  /**
   * Mirrors library.js's private extractRowsFromQafResponse() unwrap
   * heuristic so RNSP responses are read the same way the rest of the app
   * already reads API responses, rather than inventing a new envelope
   * convention.
   */
  function extractRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    if (Array.isArray(payload.Items)) return payload.Items;
    if (Array.isArray(payload.Data)) return payload.Data;
    if (Array.isArray(payload.Value)) return payload.Value;
    if (Array.isArray(payload.value)) return payload.value;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.result)) return payload.result;
    if (Array.isArray(payload.rows)) return payload.rows;
    if (Array.isArray(payload.items)) return payload.items;
    return [];
  }

  /**
   * extractRows() only handles the "array of records" envelope. Some
   * workflows (Lease Ageing was the one that surfaced this) return a FLAT
   * object instead — e.g. { Overdue: 5, "Due0to30": 6, ... } rather than
   * [{ Bucket: "Overdue", Count: 5 }, ...]. When extractRows() finds
   * nothing, this falls back to treating every own-property of the object
   * whose value is a plain number (or numeric string) as one row, so a
   * flat bucket→count style response still renders instead of silently
   * showing "no records" despite the API genuinely returning data. Logs
   * which path it took so this is visible in the console rather than a
   * silent guess.
   */
  function extractRowsFlexible(payload, workflowName) {
    var rows = extractRows(payload);
    if (rows.length) return rows;
    if (Array.isArray(payload) || !payload || typeof payload !== 'object') return [];

    var keys = Object.keys(payload).filter(function (k) {
      var v = payload[k];
      if (v == null) return false;
      if (typeof v === 'number') return true;
      if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return true;
      return false;
    });
    if (!keys.length) return [];
    console.info('[lease-dashboard] ' + (workflowName || '') +
      ' response was a flat object, not an array — treating each key as a row (' + JSON.stringify(keys) + '). ' +
      'If this mapping looks wrong, check the raw response logged above.');
    return keys.map(function (k) { return { __flatKey: k, __flatValue: payload[k] }; });
  }

  function humanizeKey(k) {
    return String(k)
      .replace(/_/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .trim();
  }

  /**
   * Case/space/underscore-insensitive field lookup. Never fabricates a
   * value — returns undefined (and logs what it tried) if nothing in
   * `candidates` actually exists on `obj`, so a missing mapping is visible
   * rather than silently producing a wrong number.
   */
  function pickField(obj, candidates, context) {
    if (!obj || typeof obj !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, '__flatKey')) return undefined; // handled by callers directly
    var keys = Object.keys(obj);
    var normalize = function (s) { return String(s).toLowerCase().replace(/[\s_-]/g, ''); };
    var normKeys = keys.map(normalize);
    for (var i = 0; i < candidates.length; i++) {
      var idx = normKeys.indexOf(normalize(candidates[i]));
      if (idx !== -1 && obj[keys[idx]] != null && obj[keys[idx]] !== '') return obj[keys[idx]];
    }
    console.warn('[lease-dashboard] none of the expected fields ' + JSON.stringify(candidates) +
      (context ? ' (' + context + ')' : '') + ' were found. Actual keys on this record: ' + JSON.stringify(keys));
    return undefined;
  }

  function toNumber(v, fallback) {
    var n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? (fallback === undefined ? 0 : fallback) : n;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtCur(n) {
    n = toNumber(n, 0);
    if (n >= 10000000) return '\u20B9' + (n / 10000000).toFixed(2) + ' Cr';
    if (n >= 100000) return '\u20B9' + (n / 100000).toFixed(2) + ' L';
    return '\u20B9' + n.toLocaleString('en-IN');
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function toIsoDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function fmtDisplayDate(isoOrDate) {
    var d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
    if (isNaN(d.getTime())) return String(isoOrDate || '');
    var m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return pad2(d.getDate()) + ' ' + m[d.getMonth()] + ' ' + d.getFullYear();
  }

  // ------------------------------------------------------------------
  // Filter state
  // ------------------------------------------------------------------

  var state = {
    filter: {
      rangeValue: '7', // '7' | '30' | '90' | 'custom' — spec: default is 7 Days, never "All"
      from: '',
      to: '',
      department: 'All',
      location: 'All',
      vendor: 'All',
      category: 'All',
      assetType: 'All'
    },
    renewTab: 'upcoming',
    renewRowsRaw: [], // last-fetched Lease Asset Renewals rows, for client-side tab filtering
    gridInstance: null
  };

  function calcDateRange(filter) {
    var today = new Date();
    if (filter.rangeValue === 'custom') {
      // Spec: never send "All"/null/empty for a required date parameter.
      var from = filter.from || toIsoDate(today);
      var to = filter.to || toIsoDate(today);
      return { StartDate: from, EndDate: to };
    }
    var days = parseInt(filter.rangeValue, 10) || 7;
    var start = new Date(today);
    start.setDate(start.getDate() - days);
    return { StartDate: toIsoDate(start), EndDate: toIsoDate(today) };
  }

  function buildArgs(filter) {
    var range = calcDateRange(filter);
    return {
      StartDate: range.StartDate,
      EndDate: range.EndDate,
      CategoryFilter: filter.category || 'All',
      AssetTypeFilter: filter.assetType || 'All',
      DepartmentFilter: filter.department || 'All',
      VendorFilter: filter.vendor || 'All',
      LocationFilter: filter.location || 'All'
    };
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  function showComponentError(containerEl, workflowName, err) {
    console.error('[lease-dashboard] ' + workflowName + ' failed:', err);
    if (!containerEl) return;
    containerEl.innerHTML = '<div class="lease-grid-error">Could not load "' + escapeHtml(workflowName) +
      '". ' + escapeHtml(err && err.message ? err.message : 'Unknown error') + '</div>';
  }

  function renderKpis(payload) {
    var row = Array.isArray(payload) ? payload[0] : (extractRows(payload)[0] || payload);
    if (!row || typeof row !== 'object') throw new Error('unexpected response shape for summary cards');

    var total = pickField(row, ['TotalLeaseAssets', 'Total_Lease_Assets', 'Total'], WORKFLOWS.summary);
    var active = pickField(row, ['ActiveLeases', 'Active_Leases', 'Active'], WORKFLOWS.summary);
    var renewalsDue = pickField(row, ['RenewalsDue', 'Renewals_Due'], WORKFLOWS.summary);
    var leasesDue = pickField(row, ['LeasesDue', 'Leases_Due', 'LeasesDuePayable'], WORKFLOWS.summary);
    var monthlyCost = pickField(row, ['MonthlyLeaseCost', 'Monthly_Lease_Cost', 'MonthlyCost'], WORKFLOWS.summary);

    document.getElementById('kpiTotal').textContent = total != null ? total : '—';
    document.getElementById('kpiActive').textContent = active != null ? active : '—';
    document.getElementById('kpiRenewals').textContent = renewalsDue != null ? renewalsDue : '—';
    document.getElementById('kpiDue').textContent = leasesDue != null ? fmtCur(leasesDue) : '—';
    document.getElementById('kpiCost').textContent = monthlyCost != null ? fmtCur(monthlyCost) : '—';

    var totalSub = pickField(row, ['TotalLeaseAssetsSub', 'ActiveSub'], WORKFLOWS.summary);
    var activeSub = pickField(row, ['ActiveLeasesSub'], WORKFLOWS.summary);
    var renewalsSub = pickField(row, ['RenewalsDueSub'], WORKFLOWS.summary);
    var dueSub = pickField(row, ['LeasesDueSub'], WORKFLOWS.summary);
    var costSub = pickField(row, ['MonthlyLeaseCostSub'], WORKFLOWS.summary);
    document.getElementById('kpiTotalSub').textContent = totalSub || '';
    document.getElementById('kpiActiveSub').textContent = activeSub || '';
    document.getElementById('kpiRenewalsSub').textContent = renewalsSub || '';
    document.getElementById('kpiDueSub').textContent = dueSub || '';
    document.getElementById('kpiCostSub').textContent = costSub || '';
  }

  function renderBars(containerEl, payload, fillColor, workflowName, totalsEls) {
    var rows = extractRowsFlexible(payload, workflowName);
    containerEl.innerHTML = '';
    if (!rows.length) {
      containerEl.innerHTML = '<div class="text-muted" style="font-size:12px">No records for the current filters.</div>';
      if (totalsEls) { totalsEls.count.textContent = '0'; totalsEls.value.textContent = fmtCur(0); }
      return;
    }
    var items = rows.map(function (r) {
      if (Object.prototype.hasOwnProperty.call(r, '__flatKey')) {
        return { label: humanizeKey(r.__flatKey), count: toNumber(r.__flatValue, 0), value: 0 };
      }
      var label = pickField(r, ['Department', 'Location', 'Label', 'Name', 'Group'], workflowName);
      var count = toNumber(pickField(r, ['Count', 'AssetCount', 'Total'], workflowName), 0);
      var value = toNumber(pickField(r, ['MonthlyValue', 'MonthlyRent', 'Value'], workflowName), 0);
      return { label: label, count: count, value: value };
    });
    var max = Math.max.apply(null, items.map(function (i) { return i.count || i.value || 0; }).concat([1]));
    var frag = document.createDocumentFragment();
    items.forEach(function (item) {
      var raw = item.count || item.value || 0;
      var pct = max ? (raw / max) * 100 : 0;
      var row = document.createElement('div');
      row.className = 'lease-bar-row';
      row.innerHTML =
        '<div class="label">' + escapeHtml(item.label || '—') + '</div>' +
        '<div class="track"><div class="fill" style="width:' + pct + '%;background:' + fillColor + '"></div></div>' +
        '<div class="value">' + item.count + (item.value ? ' \u00B7 ' + fmtCur(item.value) : '') + '</div>';
      frag.appendChild(row);
    });
    containerEl.appendChild(frag);

    if (totalsEls) {
      var totalCount = items.reduce(function (a, i) { return a + toNumber(i.count, 0); }, 0);
      var totalValue = items.reduce(function (a, i) { return a + toNumber(i.value, 0); }, 0);
      totalsEls.count.textContent = String(totalCount);
      totalsEls.value.textContent = fmtCur(totalValue);
    }
  }

  var STATUS_COLORS = {
    'Active': '#10b981',
    'Expiring Soon': '#f59e0b',
    'Overdue Renewal': '#ef4444',
    'Expired': '#94a3b8',
    'Renewed': '#3b82f6'
  };
  var STATUS_ORDER = ['Active', 'Expiring Soon', 'Overdue Renewal', 'Expired', 'Renewed'];

  function renderStatusMix(payload) {
    var rows = extractRowsFlexible(payload, WORKFLOWS.statusMix);
    var svg = document.getElementById('statusDonut');
    var legendEl = document.getElementById('statusLegend');
    legendEl.innerHTML = '';
    // Keep the base track circle, drop any previously drawn segments/labels.
    Array.from(svg.querySelectorAll('.lease-status-seg, .lease-status-label')).forEach(function (n) { n.remove(); });

    if (!rows.length) {
      legendEl.innerHTML = '<div class="text-muted" style="font-size:12px">No records for the current filters.</div>';
      return;
    }

    var items = rows.map(function (r) {
      if (Object.prototype.hasOwnProperty.call(r, '__flatKey')) {
        return { status: humanizeKey(r.__flatKey), count: toNumber(r.__flatValue, 0) };
      }
      return {
        status: pickField(r, ['Status', 'LeaseStatus'], WORKFLOWS.statusMix),
        count: toNumber(pickField(r, ['Count', 'AssetCount'], WORKFLOWS.statusMix), 0)
      };
    });
    var total = items.reduce(function (a, i) { return a + i.count; }, 0) || 1;
    var C = 2 * Math.PI * 60;
    var acc = 0;
    var svgNs = 'http://www.w3.org/2000/svg';

    var ordered = STATUS_ORDER.map(function (s) { return items.find(function (i) { return i.status === s; }); })
      .concat(items.filter(function (i) { return STATUS_ORDER.indexOf(i.status) === -1; }))
      .filter(Boolean);

    ordered.forEach(function (item) {
      if (!item.count) return;
      var frac = item.count / total;
      var len = frac * C;
      var circle = document.createElementNS(svgNs, 'circle');
      circle.setAttribute('class', 'lease-status-seg');
      circle.setAttribute('cx', '80'); circle.setAttribute('cy', '80'); circle.setAttribute('r', '60');
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', STATUS_COLORS[item.status] || '#64748b');
      circle.setAttribute('stroke-width', '22');
      circle.setAttribute('stroke-dasharray', len.toFixed(2) + ' ' + (C - len).toFixed(2));
      circle.setAttribute('stroke-dashoffset', (-acc).toFixed(2));
      circle.setAttribute('transform', 'rotate(-90 80 80)');
      svg.appendChild(circle);
      acc += len;

      var legendRow = document.createElement('div');
      legendRow.className = 'lease-status-legend__row';
      legendRow.innerHTML =
        '<span class="lease-status-dot" style="background:' + (STATUS_COLORS[item.status] || '#64748b') + '"></span>' +
        '<span class="lease-status-legend__text"><b>' + escapeHtml(item.status || 'Unknown') + '</b>' +
        '<span>' + item.count + ' assets \u00B7 ' + Math.round(frac * 100) + '%</span></span>';
      legendEl.appendChild(legendRow);
    });

    var centerText = document.createElementNS(svgNs, 'text');
    centerText.setAttribute('class', 'lease-status-label');
    centerText.setAttribute('x', '80'); centerText.setAttribute('y', '76'); centerText.setAttribute('text-anchor', 'middle');
    centerText.setAttribute('style', 'font-size:24px;font-weight:300;fill:#111827');
    centerText.textContent = String(total);
    svg.appendChild(centerText);
    var subText = document.createElementNS(svgNs, 'text');
    subText.setAttribute('class', 'lease-status-label');
    subText.setAttribute('x', '80'); subText.setAttribute('y', '94'); subText.setAttribute('text-anchor', 'middle');
    subText.setAttribute('style', 'font-size:9px;fill:#64748b;letter-spacing:0.06em');
    subText.textContent = 'LEASE ASSETS';
    svg.appendChild(subText);
  }

  function renderAgeing(payload) {
    var rows = extractRowsFlexible(payload, WORKFLOWS.ageing);
    var container = document.getElementById('ageingBars');
    container.innerHTML = '';
    document.getElementById('ageingMeta').textContent = '';
    if (!rows.length) {
      container.innerHTML = '<div class="text-muted" style="font-size:12px">No records for the current filters.</div>';
      return;
    }
    var items = rows.map(function (r) {
      if (Object.prototype.hasOwnProperty.call(r, '__flatKey')) {
        return { bucket: humanizeKey(r.__flatKey), count: toNumber(r.__flatValue, 0) };
      }
      return {
        bucket: pickField(r, ['Bucket', 'AgeingBucket', 'Label'], WORKFLOWS.ageing),
        count: toNumber(pickField(r, ['Count', 'AssetCount'], WORKFLOWS.ageing), 0)
      };
    });
    var total = items.reduce(function (a, i) { return a + i.count; }, 0);
    document.getElementById('ageingMeta').textContent = total + ' assets \u00B7 by lease end date';
    var max = Math.max.apply(null, items.map(function (i) { return i.count; }).concat([1]));
    var bucketColors = ['#ef4444', '#f59e0b', '#3b82f6', '#8b7cf6', '#94a3b8'];
    var frag = document.createDocumentFragment();
    items.forEach(function (item, i) {
      var pct = max ? (item.count / max) * 100 : 0;
      var row = document.createElement('div');
      row.className = 'lease-bar-row lease-ageing-row';
      row.innerHTML =
        '<div class="label">' + escapeHtml(item.bucket || '—') + '</div>' +
        '<div class="track"><div class="fill" style="width:' + pct + '%;background:' + (bucketColors[i % bucketColors.length]) + '"></div></div>' +
        '<div class="value">' + item.count + '</div>';
      frag.appendChild(row);
    });
    container.appendChild(frag);
  }

  var RENEWAL_COLUMNS = [
    { key: 'id', label: 'Asset ID', minWidth: 90 },
    { key: 'asset', label: 'Lease Asset', minWidth: 160, emphasis: true },
    { key: 'dept', label: 'Department', minWidth: 100 },
    { key: 'location', label: 'Location', minWidth: 100 },
    { key: 'vendor', label: 'Lessor / Vendor', minWidth: 120 },
    { key: 'end', label: 'Lease End', minWidth: 100 },
    { key: 'days', label: 'Days', minWidth: 70, align: 'right' },
    { key: 'status', label: 'Renewal Status', minWidth: 140, sortable: false }
  ];

  function badgeClassFor(days) {
    if (days == null || isNaN(days)) return 'badge--lease-neutral';
    if (days < 0) return 'badge--lease-danger';
    if (days <= 30) return 'badge--lease-warn';
    if (days <= 90) return 'badge--lease-info';
    return 'badge--lease-neutral';
  }
  function badgeTextFor(days) {
    if (days == null || isNaN(days)) return 'Scheduled';
    if (days < 0) return 'Renewal overdue';
    if (days <= 30) return 'Renew this month';
    if (days <= 90) return 'Upcoming renewal';
    return 'Scheduled';
  }

  function mapRenewalRow(r) {
    var endDate = pickField(r, ['LeaseEndDate', 'LeaseEnd', 'EndDate'], WORKFLOWS.renewals);
    var daysRaw = pickField(r, ['DaysLeft', 'Days', 'DaysToRenewal'], WORKFLOWS.renewals);
    var days = daysRaw != null ? toNumber(daysRaw, null) : null;
    if (days == null && endDate) {
      var d = new Date(endDate);
      if (!isNaN(d.getTime())) days = Math.round((d - new Date()) / 86400000);
    }
    return {
      id: pickField(r, ['AssetId', 'AssetID', 'Id'], WORKFLOWS.renewals) || '',
      asset: pickField(r, ['AssetName', 'LeaseAsset', 'Asset'], WORKFLOWS.renewals) || '',
      dept: pickField(r, ['Department'], WORKFLOWS.renewals) || '',
      location: pickField(r, ['Location'], WORKFLOWS.renewals) || '',
      vendor: pickField(r, ['Vendor', 'Lessor'], WORKFLOWS.renewals) || '',
      end: endDate || '',
      endTime: endDate ? new Date(endDate).getTime() : NaN,
      days: days,
      status: pickField(r, ['Status', 'RenewalStatus'], WORKFLOWS.renewals) || ''
    };
  }

  function ensureGrid() {
    if (state.gridInstance) return state.gridInstance;
    var wrap = document.getElementById('renewalsGridWrap');
    wrap.innerHTML =
      '<table class="asset-table lease-renewals-table" id="renewalsTable" data-resize-key="lease-asset-renewals">' +
      '<thead><tr>' +
      RENEWAL_COLUMNS.map(function (c) {
        return '<th' + (c.align ? ' data-align="' + c.align + '"' : '') +
          (c.sortable === false ? ' class="no-sort"' : ' class="gt-sortable"') + '>' + escapeHtml(c.label) + '</th>';
      }).join('') +
      '</tr></thead><tbody></tbody></table>';
    var table = document.getElementById('renewalsTable');
    state.gridInstance = window.GridTable.create(table, {
      resizeStorageKey: 'lease-asset-renewals',
      columnMinWidths: RENEWAL_COLUMNS.map(function (c) { return c.minWidth || 90; })
    });
    return state.gridInstance;
  }

  function renderRenewalsTbody(rows) {
    var tbody = document.querySelector('#renewalsTable tbody');
    tbody.innerHTML = '';
    if (!rows.length) {
      var tr = document.createElement('tr');
      tr.className = 'lease-empty-row';
      var td = document.createElement('td');
      td.colSpan = RENEWAL_COLUMNS.length;
      td.innerHTML = '<span class="text-muted">No leases match the current filters.</span>';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    var frag = document.createDocumentFragment();
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      var daysText = r.days == null ? '—' : (r.days < 0 ? Math.abs(r.days) + 'd late' : r.days + 'd');
      tr.innerHTML =
        '<td>' + escapeHtml(r.id) + '</td>' +
        '<td class="gt-emphasis">' + escapeHtml(r.asset) + '</td>' +
        '<td>' + escapeHtml(r.dept) + '</td>' +
        '<td>' + escapeHtml(r.location) + '</td>' +
        '<td>' + escapeHtml(r.vendor) + '</td>' +
        '<td data-sort-value="' + (isNaN(r.endTime) ? '' : r.endTime) + '">' + (r.end ? escapeHtml(fmtDisplayDate(r.end)) : '—') + '</td>' +
        '<td data-align="right" data-sort-value="' + (r.days == null ? '' : r.days) + '">' + daysText + '</td>' +
        '<td><span class="badge ' + badgeClassFor(r.days) + '">' + escapeHtml(r.status || badgeTextFor(r.days)) + '</span></td>';
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  function applyRenewTabFilter(rows) {
    if (state.renewTab === 'upcoming') return rows.filter(function (r) { return r.days == null || r.days >= 0; });
    if (state.renewTab === 'overdue') return rows.filter(function (r) { return r.days != null && r.days < 0; });
    return rows; // 'all'
  }

  function renderRenewals(payload) {
    var rows = extractRowsFlexible(payload, WORKFLOWS.renewals).map(mapRenewalRow);
    state.renewRowsRaw = rows;
    var overdueCount = rows.filter(function (r) { return r.days != null && r.days < 0; }).length;
    document.getElementById('renewMeta').textContent = rows.length + ' leases \u00B7 ' + overdueCount + ' overdue';
    ensureGrid();
    renderRenewalsTbody(applyRenewTabFilter(rows));
    state.gridInstance.refresh();
  }

  // ------------------------------------------------------------------
  // Filter drawer population (ASSET_VALUE_FILTER)
  // ------------------------------------------------------------------

  function populateSelect(selectEl, values) {
    if (!values || !values.length) return; // spec: don't invent options that weren't returned
    var current = selectEl.value;
    selectEl.innerHTML = '<option value="All">All</option>' +
      values.map(function (v) { return '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + '</option>'; }).join('');
    if (values.indexOf(current) !== -1) selectEl.value = current;
  }

  async function loadFilterValues() {
    var payload;
    try {
      payload = await callRnsp(FILTER_VALUES_WORKFLOW, {});
    } catch (err) {
      console.error('[lease-dashboard] ' + FILTER_VALUES_WORKFLOW + ' failed:', err);
      return; // filters just stay at "All" — no fabricated options
    }
    var obj = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
    var deptVals = pickField(obj, ['Departments', 'Department'], FILTER_VALUES_WORKFLOW);
    var locVals = pickField(obj, ['Locations', 'Location'], FILTER_VALUES_WORKFLOW);
    var vendorVals = pickField(obj, ['Vendors', 'Vendor'], FILTER_VALUES_WORKFLOW);
    var categoryVals = pickField(obj, ['Categories', 'Category'], FILTER_VALUES_WORKFLOW);
    var assetTypeVals = pickField(obj, ['AssetTypes', 'AssetType'], FILTER_VALUES_WORKFLOW);

    if (Array.isArray(deptVals)) populateSelect(document.getElementById('fDepartment'), deptVals);
    if (Array.isArray(locVals)) populateSelect(document.getElementById('fLocation'), locVals);
    if (Array.isArray(vendorVals)) populateSelect(document.getElementById('fVendor'), vendorVals);
    if (Array.isArray(categoryVals)) populateSelect(document.getElementById('fCategory'), categoryVals);
    if (Array.isArray(assetTypeVals)) populateSelect(document.getElementById('fAssetType'), assetTypeVals);
  }

  // ------------------------------------------------------------------
  // Orchestration
  // ------------------------------------------------------------------

  function updateFilterSummary() {
    var f = state.filter;
    var chips = [];
    ['department', 'location', 'vendor', 'category', 'assetType'].forEach(function (k) {
      if (f[k] && f[k] !== 'All') chips.push(f[k]);
    });
    var rangeLabel = f.rangeValue === 'custom' ? (f.from || f.to ? f.from + ' \u2192 ' + f.to : 'Custom') : f.rangeValue + ' Days';
    chips.push(rangeLabel);
    var el = document.getElementById('filterSummary');
    el.textContent = 'Filtered: ' + chips.join(' \u00B7 ');
    el.classList.toggle('has-filters', chips.length > 1 || f.rangeValue !== '7');
  }

  async function loadDashboardData() {
    var args = buildArgs(state.filter);
    updateFilterSummary();

    var jobs = [
      { name: WORKFLOWS.summary, run: renderKpis, container: document.getElementById('kpiGrid') },
      { name: WORKFLOWS.statusMix, run: renderStatusMix, container: document.getElementById('statusLegend') },
      { name: WORKFLOWS.ageing, run: renderAgeing, container: document.getElementById('ageingBars') },
      { name: WORKFLOWS.renewals, run: renderRenewals, container: document.getElementById('renewalsGridWrap') },
      {
        name: WORKFLOWS.department, run: function (p) {
          renderBars(document.getElementById('deptBars'), p, '#2563eb', WORKFLOWS.department,
            { count: document.getElementById('deptTotalAssets'), value: document.getElementById('deptTotalRent') });
        },
        container: document.getElementById('deptBars')
      },
      {
        name: WORKFLOWS.location, run: function (p) {
          renderBars(document.getElementById('locBars'), p, '#8b7cf6', WORKFLOWS.location,
            { count: document.getElementById('locTotalAssets'), value: document.getElementById('locTotalRent') });
        },
        container: document.getElementById('locBars')
      }
    ];

    // Run independently: one workflow failing must not blank the rest of
    // the dashboard (spec: distinguishable per-workflow errors).
    await Promise.all(jobs.map(function (job) {
      return callRnsp(job.name, args)
        .then(job.run)
        .catch(function (err) { showComponentError(job.container, job.name, err); });
    }));
  }

  // ------------------------------------------------------------------
  // Filter drawer wiring
  // ------------------------------------------------------------------

  function openFilterDrawer() {
    var f = state.filter;
    document.getElementById('fDateRange').value = f.rangeValue;
    document.getElementById('fFrom').value = f.from;
    document.getElementById('fTo').value = f.to;
    document.getElementById('fDepartment').value = f.department;
    document.getElementById('fLocation').value = f.location;
    document.getElementById('fVendor').value = f.vendor;
    document.getElementById('fCategory').value = f.category;
    document.getElementById('fAssetType').value = f.assetType;
    document.getElementById('customDateFields').style.display = f.rangeValue === 'custom' ? 'flex' : 'none';
    document.getElementById('filterOverlay').style.display = 'flex';
  }
  function closeFilterDrawer() {
    document.getElementById('filterOverlay').style.display = 'none';
  }

  function wireEvents() {
    document.getElementById('openFiltersBtn').addEventListener('click', openFilterDrawer);
    document.getElementById('closeFiltersBtn').addEventListener('click', closeFilterDrawer);
    document.getElementById('filterOverlay').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) closeFilterDrawer();
    });

    document.getElementById('fDateRange').addEventListener('change', function (e) {
      document.getElementById('customDateFields').style.display = e.target.value === 'custom' ? 'flex' : 'none';
    });

    document.getElementById('resetFiltersBtn').addEventListener('click', function () {
      state.filter = { rangeValue: '7', from: '', to: '', department: 'All', location: 'All', vendor: 'All', category: 'All', assetType: 'All' };
      closeFilterDrawer();
      loadDashboardData();
    });

    document.getElementById('applyFiltersBtn').addEventListener('click', function () {
      state.filter = {
        rangeValue: document.getElementById('fDateRange').value,
        from: document.getElementById('fFrom').value,
        to: document.getElementById('fTo').value,
        department: document.getElementById('fDepartment').value,
        location: document.getElementById('fLocation').value,
        vendor: document.getElementById('fVendor').value,
        category: document.getElementById('fCategory').value,
        assetType: document.getElementById('fAssetType').value
      };
      closeFilterDrawer();
      loadDashboardData(); // spec: re-call the six workflows, never reload the page
    });

    document.getElementById('renewTabs').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      state.renewTab = btn.getAttribute('data-tab');
      Array.from(document.querySelectorAll('#renewTabs button')).forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
      });
      renderRenewalsTbody(applyRenewTabFilter(state.renewRowsRaw));
      if (state.gridInstance) state.gridInstance.refresh();
    });
  }

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------

  function init() {
    console.debug('[lease-dashboard] init() running, document.readyState =', document.readyState);
    wireEvents();
    loadFilterValues();     // spec: 1 x ASSET_VALUE_FILTER on initial load only
    loadDashboardData();    // spec: 6 x dashboard workflows, 7-day default window
  }

  // IMPORTANT: this page is loaded into an existing SPA shell (QuickAppFlow's
  // page router), not as a fresh document navigation. That means
  // 'DOMContentLoaded' has very likely already fired on the *host* document
  // by the time this script tag executes, so a plain
  // `document.addEventListener('DOMContentLoaded', init)` would silently
  // never run — which is why no RNSP calls were firing. Run immediately if
  // the DOM is already parsed; only wait if it genuinely isn't yet.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Exposed as a manual fallback in case the host page framework injects
  // this markup+script combination in a way that still doesn't execute the
  // inline script synchronously (e.g. innerHTML-based injection, which never
  // runs <script> tags at all). If nothing loads and the console shows no
  // "[lease-dashboard] init() running" line, the host page needs to call
  // window.initLeaseAssetDashboard() itself after inserting this page's DOM.
  window.initLeaseAssetDashboard = init;
})();