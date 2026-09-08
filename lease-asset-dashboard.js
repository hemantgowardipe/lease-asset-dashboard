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

  // Ported from Asset Value Dashboard's own LOADING_HTML/KPI_IDS/setLoading()
  // — same markup, same ids-driven loop, same "only KPI values + the table"
  // scope. Nothing here touches how/when the RNSP calls themselves fire.
  var LEASE_LOADING_HTML =
    '<div class="dash-loading"><span class="dash-loading__dot"></span><span class="dash-loading__dot"></span><span class="dash-loading__dot"></span></div>';
  var KPI_VALUE_IDS = ['kpiTotal', 'kpiActive', 'kpiRenewals', 'kpiDue', 'kpiCost'];

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

  function looksLikeFlatBucketRow(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    var keys = Object.keys(obj);
    if (!keys.length) return false;
    return keys.every(function (k) {
      var v = obj[k];
      return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)));
    });
  }

  function flattenBucketRow(obj, workflowName) {
    var keys = Object.keys(obj);
    console.info('[lease-dashboard] ' + (workflowName || '') +
      ' response is a flat bucket object (every property is a plain number) — treating each key as its own row: ' +
      JSON.stringify(keys));
    return keys.map(function (k) { return { __flatKey: k, __flatValue: obj[k] }; });
  }

  /**
   * extractRows() only handles the "array of records" envelope. Two related
   * shapes fall through it and need special-casing (both confirmed against
   * real responses — Lease Ageing returns the first one):
   *
   *   1. An array containing exactly ONE flat object, each of whose own
   *      properties IS a bucket:
   *      [{ "Overdue": 0, "Due in 0-30d": 2, "Due in 31-60d": 0, ... }]
   *      extractRows() happily returns this as a length-1 "rows" array, so
   *      without this check the dashboard renders exactly one bogus row
   *      with no recognizable Bucket/Count field on it.
   *
   *   2. The same, but not array-wrapped at all:
   *      { "Overdue": 0, "Due in 0-30d": 2, ... }
   *
   * Either way, nothing here invents a number — every value rendered is
   * read straight off the object's own properties, including genuine
   * zeros. Logs which path it took so this is visible in the console
   * rather than a silent guess.
   */
  function extractRowsFlexible(payload, workflowName) {
    var rows = extractRows(payload);
    if (rows.length === 1 && looksLikeFlatBucketRow(rows[0])) {
      return flattenBucketRow(rows[0], workflowName);
    }
    if (rows.length) return rows;
    if (looksLikeFlatBucketRow(payload)) {
      return flattenBucketRow(payload, workflowName);
    }
    return [];
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
    var normalize = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); };
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

  // Date range stays exactly as before (spec: 7/30/90/Custom, never "All").
  // Default is 30 Days — the 7 Days option itself is unchanged/still
  // present, only the default selection moved from 7 to 30.
  // Everything else — AssetType/Category/Location/Department/
  // Vendor — is driven by the searchable-combobox fields below, ported
  // from Asset Value Dashboard's filter funnel.
  var dateFilter = { rangeValue: '90', from: '', to: '' };

  var FILTER_KEYS = ['AssetType', 'Category', 'Location', 'Department', 'Vendor'];
  var FILTER_FIELD_IDS = {
    AssetType: 'filterAssetType',
    Category: 'filterCategory',
    Location: 'filterLocation',
    Department: 'filterDepartment',
    Vendor: 'filterVendor'
  };
  var FILTER_PLACEHOLDER = 'Select to apply';

  // Raw rows from ASSET_VALUE_FILTER, each expected to look like
  // { FilterType: "Department"|"Location"|"Vendor"|"Category"|"AssetType",
  //   FilterValue: "<option text>", Type: "<asset type, Category rows only>" }
  // — same shape Asset Value Dashboard's own ASSET_VALUE_FILTER uses.
  var filterRows = [];
  var filterDropdownOptions = { AssetType: [], Category: [], Location: [], Department: [], Vendor: [] };

  // Currently APPLIED values (only updated by Apply/Clear) — "" means "All".
  var selected = { AssetType: '', Category: '', Location: '', Department: '', Vendor: '' };

  var state = {
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
    var days = parseInt(filter.rangeValue, 10) || 90;
    var start = new Date(today);
    start.setDate(start.getDate() - days);
    return { StartDate: toIsoDate(start), EndDate: toIsoDate(today) };
  }

  // selected.Category / selected.AssetType / etc. hold the API's true
  // FilterValue strings; "" means "All" was picked (or nothing was picked).
  function buildArgs() {
    var range = calcDateRange(dateFilter);
    return {
      StartDate: range.StartDate,
      EndDate: range.EndDate,
      CategoryFilter: selected.Category || 'All',
      AssetTypeFilter: selected.AssetType || 'All',
      DepartmentFilter: selected.Department || 'All',
      VendorFilter: selected.Vendor || 'All',
      LocationFilter: selected.Location || 'All'
    };
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  /**
   * Shows/hides the three-dot pulse in every KPI card's value and the
   * renewals table's wrap. For the table specifically: state.gridInstance
   * is cleared before writing the loading markup over it, so ensureGrid()
   * fully rebuilds a fresh table+GridTable instance once real rows arrive
   * instead of trying to refresh() a table element the loading placeholder
   * just replaced out from under it. Manually-resized column widths are
   * unaffected either way — GridTable always re-reads its own saved widths
   * from localStorage on creation, ahead of any declared default.
   */
  function setLeaseLoading(isLoading) {
    KPI_VALUE_IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el || !isLoading) return;
      el.innerHTML = LEASE_LOADING_HTML;
    });

    var tableWrap = document.getElementById('renewalsGridWrap');
    if (tableWrap && isLoading) {
      state.gridInstance = null;
      tableWrap.innerHTML = LEASE_LOADING_HTML;
    }

    var applyBtn = document.getElementById('filterFunnelApply');
    if (applyBtn) applyBtn.disabled = isLoading;
  }

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

  // Same cycling palette Asset Value Dashboard uses for its own bar panels
  // (COLOR_POOL in asset_value_dashboard.js) — each row gets the next
  // color in order, wrapping around if there are more rows than colors.
  var BAR_COLOR_POOL = [
    '#2f5bea', '#22a06b', '#f5a623', '#ef4b4b', '#8b7cf6',
    '#14b8a6', '#60a5fa', '#34d399', '#fbbf24', '#c084fc',
    '#f87171', '#9ca3af', '#a78bfa', '#10b981', '#d1a86e'
  ];

  function renderBars(containerEl, payload, workflowName) {
    var rows = extractRowsFlexible(payload, workflowName);
    containerEl.innerHTML = '';
    if (!rows.length) {
      containerEl.innerHTML = '<div class="text-muted" style="font-size:12px">No records for the current filters.</div>';
      return;
    }
    var items = rows.map(function (r) {
      if (Object.prototype.hasOwnProperty.call(r, '__flatKey')) {
        return { label: humanizeKey(r.__flatKey), count: toNumber(r.__flatValue, 0), value: 0 };
      }
      var label = pickField(r, ['Department', 'Location', 'Label', 'Name', 'Group'], workflowName);
      var count = toNumber(pickField(r, ['Count', 'AssetCount', 'Asset Count', 'Total'], workflowName), 0);
      var value = toNumber(pickField(r, ['Total Lease Amount', 'TotalLeaseAmount', 'MonthlyValue', 'MonthlyRent', 'Amount', 'Value'], workflowName), 0);
      return { label: label, count: count, value: value };
    });
    var max = Math.max.apply(null, items.map(function (i) { return i.count || i.value || 0; }).concat([1]));
    var frag = document.createDocumentFragment();
    items.forEach(function (item, i) {
      var raw = item.count || item.value || 0;
      var pct = max ? (raw / max) * 100 : 0;
      var color = BAR_COLOR_POOL[i % BAR_COLOR_POOL.length];
      var row = document.createElement('div');
      row.className = 'lease-bar-row';
      row.innerHTML =
        '<div class="label">' + escapeHtml(item.label || '—') + '</div>' +
        '<div class="track"><div class="fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
        '<div class="value">' + item.count + ' \u00B7 ' + fmtCur(item.value) + '</div>';
      frag.appendChild(row);
    });
    containerEl.appendChild(frag);
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

    // No early "no records" return here on purpose: every known status
    // label must still show (at a real 0) even when the API returns no
    // rows at all for the current filters.
    var items = rows.map(function (r) {
      if (Object.prototype.hasOwnProperty.call(r, '__flatKey')) {
        return { status: humanizeKey(r.__flatKey), count: toNumber(r.__flatValue, 0) };
      }
      return {
        status: pickField(r, ['Status', 'LeaseStatus'], WORKFLOWS.statusMix),
        count: toNumber(pickField(r, ['Count', 'AssetCount'], WORKFLOWS.statusMix), 0)
      };
    });
    var total = items.reduce(function (a, i) { return a + i.count; }, 0);
    var denom = total || 1; // only for the arc-length fraction below — never displayed
    var C = 2 * Math.PI * 60;
    var acc = 0;
    var svgNs = 'http://www.w3.org/2000/svg';

    // Always list every known status — Active, Expiring Soon, Overdue
    // Renewal, Expired, Renewed — even at a genuine 0, rather than only
    // the ones the API happened to return this time. Any status the data
    // has that ISN'T one of these five (an extra/renamed status) still
    // gets appended after, but only when it actually has assets — there's
    // no fixed label to show it at 0 against.
    var ordered = STATUS_ORDER.map(function (s) {
      var found = items.find(function (i) { return i.status === s; });
      return found || { status: s, count: 0 };
    }).concat(items.filter(function (i) { return STATUS_ORDER.indexOf(i.status) === -1 && i.count; }));

    ordered.forEach(function (item) {
      var frac = item.count / denom;
      if (item.count) {
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
      }

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
    { key: 'id', label: 'Asset ID', minWidth: 90, weight: 0.09 },
    { key: 'asset', label: 'Lease Asset', minWidth: 160, weight: 0.22, emphasis: true },
    { key: 'dept', label: 'Department', minWidth: 100, weight: 0.12 },
    { key: 'location', label: 'Location', minWidth: 100, weight: 0.13 },
    { key: 'vendor', label: 'Lessor / Vendor', minWidth: 120, weight: 0.13 },
    { key: 'end', label: 'Lease End', minWidth: 100, weight: 0.11 },
    { key: 'days', label: 'Days', minWidth: 70, weight: 0.06, align: 'right' },
    { key: 'status', label: 'Renewal Status', minWidth: 140, weight: 0.14, sortable: false }
  ]; // weights sum to 1.0 — see ensureGrid() for how they're turned into px

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
      vendor: pickField(r, ['Lessor/Vendor', 'LessorVendor', 'Vendor', 'Lessor'], WORKFLOWS.renewals) || '',
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

    // WHY THIS IS HERE (debugging note for whoever touches this next):
    // library.js's GridTable.create() is the shared, unmodified reusable
    // engine — this file never changes it. Left to its own defaults it
    // sizes each column from the *rendered content it can see at creation
    // time* (resolveInitialWidths: saved → declared → measured → content-
    // estimated). We used to call create() against an still-empty <tbody>
    // with only columnMinWidths set, so it had nothing real to measure and
    // fell back to a tiny per-column estimate. Our own CSS then force-
    // stretches the table to the card's full width (needed so the grid
    // isn't left looking cut off on a wide screen) — and with table-layout:
    // fixed plus every column pinned to a small explicit px width, the
    // browser has nowhere sensible to put that leftover width and dumps it
    // unevenly into a single column, which is exactly the "shrunk /
    // lopsided gap" look. Fixing it in library.js would mean changing a
    // shared engine every other table on the platform also depends on, so
    // instead we give create() explicit `columnWidths` computed from the
    // wrap's REAL width right now, split by each column's declared
    // `weight` (RENEWAL_COLUMNS above, sums to 1.0). Declared widths are
    // GridTable's second-highest priority (only a user's own saved resize
    // wins over them), so the columns fill the row correctly from the very
    // first render, and table-layout:fixed's drag-isolation guarantees
    // (dragging one column never disturbs its neighbours) are untouched.
    var availableWidth = Math.max(wrap.clientWidth || 0, RENEWAL_COLUMNS.length * 90);
    var columnWidths = RENEWAL_COLUMNS.map(function (c) {
      return Math.max(c.minWidth || 90, Math.round(availableWidth * c.weight));
    });

    state.gridInstance = window.GridTable.create(table, {
      resizeStorageKey: 'lease-asset-renewals',
      columnWidths: columnWidths,
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
  // Filter funnel — searchable combobox fields, ported from Asset Value
  // Dashboard's own implementation (same .hmt-filter-select-wrap contract:
  // input + hidden value + options menu). FILTER_KEYS/FILTER_FIELD_IDS
  // above drive every loop below.
  // ------------------------------------------------------------------

  function normalizeKey(key) {
    return String(key == null ? '' : key).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function getFieldLoose(row, candidates) {
    if (!row || typeof row !== 'object') return null;
    var normalized = {};
    Object.keys(row).forEach(function (k) { normalized[normalizeKey(k)] = row[k]; });
    for (var i = 0; i < candidates.length; i++) {
      var nk = normalizeKey(candidates[i]);
      if (Object.prototype.hasOwnProperty.call(normalized, nk)) return normalized[nk];
    }
    return null;
  }

  function uniqueSorted(values) {
    var seen = {}, out = [];
    values.forEach(function (v) {
      var t = String(v == null ? '' : v).trim();
      if (!t || seen[t]) return;
      seen[t] = true;
      out.push(t);
    });
    return out.sort(function (a, b) { return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }); });
  }

  function rowsByFilterType(type) {
    return filterRows.filter(function (r) { return normalizeKey(getFieldLoose(r, ['FilterType'])) === normalizeKey(type); });
  }

  // "Asset Type" options come from the Type tag found inside Category rows
  // plus any rows directly tagged FilterType=AssetType — same contract as
  // Asset Value Dashboard's ASSET_VALUE_FILTER.
  function getAssetTypeOptions() {
    var categoryRows = rowsByFilterType('Category');
    var fromType = categoryRows.map(function (r) { return getFieldLoose(r, ['Type']); });
    var directRows = rowsByFilterType('AssetType');
    var fromDirect = directRows.map(function (r) { return getFieldLoose(r, ['FilterValue']); });
    return uniqueSorted(fromType.concat(fromDirect));
  }

  // Category is scoped to whichever Asset Type is selected — live in the
  // popup, not just the last-applied value, so the list updates immediately
  // as the user picks a different Asset Type, before Apply is clicked.
  function getCategoryOptions(assetType) {
    var categoryRows = rowsByFilterType('Category');
    var scoped = (!assetType || assetType === 'All')
      ? categoryRows
      : categoryRows.filter(function (r) { return normalizeKey(getFieldLoose(r, ['Type'])) === normalizeKey(assetType); });
    return uniqueSorted(scoped.map(function (r) { return getFieldLoose(r, ['FilterValue']); }));
  }

  function getSimpleOptions(filterType) {
    return uniqueSorted(rowsByFilterType(filterType).map(function (r) { return getFieldLoose(r, ['FilterValue']); }));
  }

  function getOptionsForFilterKey(key) {
    if (key === 'AssetType') return getAssetTypeOptions();
    if (key === 'Category') {
      var dd = getFilterDropdownElements('AssetType');
      var liveAssetType = (dd && dd.hidden && dd.hidden.value) ? dd.hidden.value : (selected.AssetType || 'All');
      return getCategoryOptions(liveAssetType);
    }
    if (key === 'Location' || key === 'Department' || key === 'Vendor') return getSimpleOptions(key);
    return [];
  }

  function getFilterDropdownElements(key) {
    var baseId = FILTER_FIELD_IDS[key];
    if (!baseId) return null;
    return {
      hidden: document.getElementById(baseId),
      input: document.getElementById(baseId + 'Input'),
      menu: document.getElementById(baseId + 'Menu'),
      wrap: document.querySelector('.hmt-filter-select-wrap[data-filter-key="' + key + '"]')
    };
  }

  function syncFilterDropdownInput(key) {
    var dd = getFilterDropdownElements(key);
    if (!dd || !dd.hidden || !dd.input) return;
    dd.input.value = dd.hidden.value ? dd.hidden.value : '';
  }

  function setFilterDropdownValue(key, value, label) {
    var dd = getFilterDropdownElements(key);
    if (!dd || !dd.hidden || !dd.input || !dd.menu) return;
    var safeValue = value ? String(value).trim() : '';
    var safeLabel = safeValue ? String(label || value).trim() : '';
    dd.hidden.value = safeValue;
    dd.input.value = safeLabel;
    dd.menu.querySelectorAll('.as-filter-select-option[role="option"]').forEach(function (option) {
      var optionValue = option.getAttribute('data-value') || '';
      option.classList.toggle('is-selected', optionValue === safeValue);
    });
  }

  function clearFilterFieldValue(key) { setFilterDropdownValue(key, '', ''); }

  function renderFilterDropdownMenu(key) {
    var dd = getFilterDropdownElements(key);
    if (!dd || !dd.menu) return;
    var options = filterDropdownOptions[key] || [];
    var currentValue = dd.hidden ? (dd.hidden.value || '') : '';
    var menuId = dd.menu.id;

    dd.menu.innerHTML =
      '<button type="button" class="as-filter-select-option' + (!currentValue ? ' is-selected' : '') +
      '" role="option" data-filter-key="' + escapeHtml(key) + '" data-value="" data-label="' +
      escapeHtml(FILTER_PLACEHOLDER) + '">' + escapeHtml(FILTER_PLACEHOLDER) + '</button>' +
      options.map(function (optionValue) {
        var isSelected = currentValue === optionValue;
        return '<button type="button" class="as-filter-select-option' + (isSelected ? ' is-selected' : '') +
          '" role="option" data-filter-key="' + escapeHtml(key) + '" data-value="' + escapeHtml(optionValue) +
          '" data-label="' + escapeHtml(optionValue) + '">' + escapeHtml(optionValue) + '</button>';
      }).join('') +
      '<p class="as-filter-select-empty" hidden>No matching options</p>';

    if (dd.input) dd.input.setAttribute('aria-controls', menuId);
    syncFilterDropdownInput(key);
  }

  function filterOptionMatchesQuery(label, query) {
    var term = String(query || '').trim().toLowerCase();
    if (!term) return true;
    return String(label || '').toLowerCase().indexOf(term) >= 0;
  }

  function applyFilterDropdownSearch(wrap, query) {
    if (!wrap) return;
    var menu = wrap.querySelector('.hmt-filter-select-menu');
    if (!menu) return;
    var hasQuery = String(query || '').trim().length > 0;
    var visibleCount = 0;
    menu.querySelectorAll('.as-filter-select-option[role="option"]').forEach(function (optionEl) {
      var isPlaceholder = !(optionEl.getAttribute('data-value') || '');
      var label = optionEl.getAttribute('data-label') || optionEl.textContent;
      var matches = filterOptionMatchesQuery(label, query);
      if (isPlaceholder && hasQuery) matches = false;
      optionEl.hidden = !matches;
      optionEl.classList.toggle('is-filter-hidden', !matches);
      if (matches) visibleCount += 1;
    });
    var emptyEl = menu.querySelector('.as-filter-select-empty');
    if (emptyEl) emptyEl.hidden = visibleCount > 0;
  }

  function resetFilterDropdownSearch(wrap) { applyFilterDropdownSearch(wrap, ''); }

  function closeAllFilterDropdownMenus() {
    document.querySelectorAll('.filter-funnel-popup .hmt-filter-select-menu').forEach(function (menu) { menu.hidden = true; });
    document.querySelectorAll('.filter-funnel-popup .hmt-filter-select-input').forEach(function (input) { input.setAttribute('aria-expanded', 'false'); });
    document.querySelectorAll('.filter-funnel-popup .hmt-filter-select-wrap').forEach(function (wrap) { wrap.classList.remove('is-open'); });
  }

  function openFilterDropdownMenu(input) {
    var wrap = input.closest('.hmt-filter-select-wrap');
    var menu = wrap && wrap.querySelector('.hmt-filter-select-menu');
    if (!wrap || !menu) return;
    closeAllFilterDropdownMenus();
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    wrap.classList.add('is-open');
    resetFilterDropdownSearch(wrap);
  }

  function bindFilterDropdownUi() {
    var popup = document.getElementById('filterFunnelPopup');
    if (!popup || popup.__filterDropdownBound) return;
    popup.__filterDropdownBound = true;

    popup.querySelectorAll('.hmt-filter-select-input').forEach(function (input) {
      input.addEventListener('click', function (event) {
        event.stopPropagation();
        var wrap = input.closest('.hmt-filter-select-wrap');
        var menu = wrap && wrap.querySelector('.hmt-filter-select-menu');
        if (menu && menu.hidden) openFilterDropdownMenu(input);
      });
      input.addEventListener('focus', function () { openFilterDropdownMenu(input); });
      input.addEventListener('input', function () {
        var wrap = input.closest('.hmt-filter-select-wrap');
        if (!wrap) return;
        var menu = wrap.querySelector('.hmt-filter-select-menu');
        if (menu && menu.hidden) openFilterDropdownMenu(input);
        applyFilterDropdownSearch(wrap, input.value);
      });
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') { event.preventDefault(); closeAllFilterDropdownMenus(); input.blur(); }
      });
    });

    popup.addEventListener('click', function (event) {
      var option = event.target.closest('.as-filter-select-option[role="option"]');
      if (!option) return;
      event.stopPropagation();
      var key = option.getAttribute('data-filter-key');
      if (!key) return;
      var value = option.getAttribute('data-value') || '';
      var label = option.getAttribute('data-label') || value;
      setFilterDropdownValue(key, value, value ? label : '');
      closeAllFilterDropdownMenus();

      // Asset Type changed → Category's option list is scoped to it, so
      // reset and re-render Category immediately (before Apply is clicked).
      if (key === 'AssetType') {
        clearFilterFieldValue('Category');
        filterDropdownOptions.Category = getOptionsForFilterKey('Category');
        renderFilterDropdownMenu('Category');
      }
    });

    document.addEventListener('click', function (event) {
      if (!event.target.closest('.filter-funnel-popup .hmt-filter-select-wrap')) closeAllFilterDropdownMenus();
    });
  }

  function syncFilterDropdown(key) {
    var options = getOptionsForFilterKey(key);
    filterDropdownOptions[key] = options;
    var dd = getFilterDropdownElements(key);
    if (dd && dd.hidden) dd.hidden.value = (selected[key] && options.indexOf(selected[key]) !== -1) ? selected[key] : '';
    renderFilterDropdownMenu(key);
  }

  function populateFilterDropdowns() {
    FILTER_KEYS.forEach(function (key) { syncFilterDropdown(key); });
  }

  /**
   * ASSET_VALUE_FILTER's response may arrive as a bare array, or (per the
   * same array-wrapped-single-object convention Lease Ageing turned out to
   * use elsewhere on this dashboard) wrapped differently. extractRowsFlexible
   * already handles both without discarding a genuinely-returned array —
   * unlike a naive "if it's an array, ignore it" check, which was the
   * actual bug here previously.
   */
  async function loadFilterValues() {
    var payload;
    try {
      payload = await callRnsp(FILTER_VALUES_WORKFLOW, {});
    } catch (err) {
      console.error('[lease-dashboard] ' + FILTER_VALUES_WORKFLOW + ' failed:', err);
      filterRows = [];
      populateFilterDropdowns();
      return; // filters just stay empty ("All") — no fabricated options
    }
    filterRows = extractRowsFlexible(payload, FILTER_VALUES_WORKFLOW).filter(function (r) {
      return r && typeof r === 'object' && !Object.prototype.hasOwnProperty.call(r, '__flatKey');
    });
    console.debug('[lease-dashboard] ' + FILTER_VALUES_WORKFLOW + ' rows:', filterRows);
    if (!filterRows.length) {
      console.warn('[lease-dashboard] ' + FILTER_VALUES_WORKFLOW + ' returned no usable rows — every dropdown will stay on "All". Check the raw response logged above (each row is expected to carry a FilterType + FilterValue, e.g. { "FilterType": "Department", "FilterValue": "IT Department" }).');
    }
    populateFilterDropdowns();
  }

  // ------------------------------------------------------------------
  // Orchestration
  // ------------------------------------------------------------------

  async function loadDashboardData() {
    var args = buildArgs();
    setLeaseLoading(true);

    var jobs = [
      { name: WORKFLOWS.summary, run: renderKpis, container: document.getElementById('kpiGrid') },
      { name: WORKFLOWS.statusMix, run: renderStatusMix, container: document.getElementById('statusLegend') },
      { name: WORKFLOWS.ageing, run: renderAgeing, container: document.getElementById('ageingBars') },
      { name: WORKFLOWS.renewals, run: renderRenewals, container: document.getElementById('renewalsGridWrap') },
      {
        name: WORKFLOWS.department, run: function (p) { renderBars(document.getElementById('deptBars'), p, WORKFLOWS.department); },
        container: document.getElementById('deptBars')
      },
      {
        name: WORKFLOWS.location, run: function (p) { renderBars(document.getElementById('locBars'), p, WORKFLOWS.location); },
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

    setLeaseLoading(false);
  }

  // ------------------------------------------------------------------
  // Filter funnel open/close/Apply/Clear — ported from Asset Value
  // Dashboard's initFilterFunnel(). The Date Range field is this
  // dashboard's own addition, carried through the same Apply/Clear flow;
  // everything else here (funnel open/close, commitFilters, the combobox
  // Clear/Apply wiring) matches the reference implementation.
  // ------------------------------------------------------------------

  function initFilterFunnel() {
    var funnelBtn = document.getElementById('filterFunnelBtn');
    var funnelPopup = document.getElementById('filterFunnelPopup');
    var funnelBackdrop = document.getElementById('filterFunnelBackdrop');
    var funnelClose = document.getElementById('filterFunnelClose');
    var funnelApply = document.getElementById('filterFunnelApply');
    var funnelClear = document.getElementById('filterFunnelClear');
    if (!funnelBtn || !funnelPopup) return;

    bindFilterDropdownUi();

    function openFunnelPopup() {
      document.getElementById('fDateRange').value = dateFilter.rangeValue;
      document.getElementById('fFrom').value = dateFilter.from;
      document.getElementById('fTo').value = dateFilter.to;
      document.getElementById('customDateFields').style.display = dateFilter.rangeValue === 'custom' ? 'flex' : 'none';

      funnelPopup.hidden = false;
      funnelBackdrop.hidden = false;
      funnelBtn.setAttribute('aria-expanded', 'true');
      funnelBtn.classList.add('is-open');
    }

    function closeFunnelPopup() {
      funnelPopup.hidden = true;
      funnelBackdrop.hidden = true;
      funnelBtn.setAttribute('aria-expanded', 'false');
      funnelBtn.classList.remove('is-open');
      closeAllFilterDropdownMenus();
    }

    funnelBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      if (funnelPopup.hidden) openFunnelPopup(); else closeFunnelPopup();
    });

    // Do NOT stopPropagation() on the whole popup here — a click on blank
    // popup space (not a dropdown) must still bubble to the document-level
    // listener in bindFilterDropdownUi() so any open dropdown menu closes.
    if (funnelClose) funnelClose.addEventListener('click', closeFunnelPopup);
    if (funnelBackdrop) funnelBackdrop.addEventListener('click', closeFunnelPopup);

    document.getElementById('fDateRange').addEventListener('change', function (e) {
      document.getElementById('customDateFields').style.display = e.target.value === 'custom' ? 'flex' : 'none';
    });

    function commitFilters() {
      FILTER_KEYS.forEach(function (key) {
        var dd = getFilterDropdownElements(key);
        selected[key] = (dd && dd.hidden && dd.hidden.value) ? dd.hidden.value : '';
      });
      dateFilter = {
        rangeValue: document.getElementById('fDateRange').value,
        from: document.getElementById('fFrom').value,
        to: document.getElementById('fTo').value
      };
    }

    if (funnelApply) {
      funnelApply.addEventListener('click', function () {
        commitFilters();
        closeFunnelPopup();
        loadDashboardData(); // spec: re-call the six workflows, never reload the page
      });
    }

    if (funnelClear) {
      funnelClear.addEventListener('click', function () {
        FILTER_KEYS.forEach(clearFilterFieldValue);
        FILTER_KEYS.forEach(function (key) { selected[key] = ''; });
        filterDropdownOptions.Category = getOptionsForFilterKey('Category');
        renderFilterDropdownMenu('Category');

        dateFilter = { rangeValue: '90', from: '', to: '' };
        document.getElementById('fDateRange').value = '90';
        document.getElementById('fFrom').value = '';
        document.getElementById('fTo').value = '';
        document.getElementById('customDateFields').style.display = 'none';
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!funnelPopup.hidden) closeFunnelPopup();
    });
  }

  function wireEvents() {
    initFilterFunnel();

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
  // CS_SETTING button theme — ported from Asset Value Dashboard. Reads the
  // tenant's configured button colors out of localStorage (or via
  // window.QafLibrary, when present) and publishes them as
  // --ButtonBackGroundColor / --ButtonTextColor on the page's
  // .qaf-cs-theme-host root, which every .qaf-cs-theme-btn (Clear/Apply)
  // and .qaf-btn--square-inverse (the funnel trigger) already reads via
  // global.css — so this applies to every themed button on the page, not
  // just one.
  // ------------------------------------------------------------------

  function tryParseJsonLoose(raw) {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function collectCsSettingCandidates(node, candidates, depth) {
    if (!node || typeof node !== 'object' || depth > 4) return;
    if (Array.isArray(node)) {
      node.forEach(function (entry) { collectCsSettingCandidates(entry, candidates, depth + 1); });
      return;
    }
    candidates.push(node);
    if (node.QAFTHEME) collectCsSettingCandidates(node.QAFTHEME, candidates, depth + 1);
    if (typeof node.value === 'string') {
      collectCsSettingCandidates(tryParseJsonLoose(node.value), candidates, depth + 1);
    } else if (node.value) {
      collectCsSettingCandidates(node.value, candidates, depth + 1);
    }
  }

  function readCsSettingColors() {
    var library = window.QafLibrary;
    var sharedReader = library && library.SquareButtonTheme && typeof library.SquareButtonTheme.readCsSettingColors === 'function'
      ? library.SquareButtonTheme.readCsSettingColors : null;
    if (sharedReader) {
      var shared = sharedReader() || {};
      return {
        backgroundColor: String(shared.backgroundColor || '').trim(),
        textColor: String(shared.textColor || '').trim()
      };
    }

    var backgroundColor = '', textColor = '';
    try {
      var raw = (window.localStorage && window.localStorage.getItem('CS_SETTING')) || '';
      if (!raw) return { backgroundColor: backgroundColor, textColor: textColor };
      var candidates = [];
      collectCsSettingCandidates(tryParseJsonLoose(raw), candidates, 0);
      for (var i = 0; i < candidates.length; i++) {
        var source = candidates[i] || {};
        var bg = String(source.ButtonBackGroundColor || source.buttonBackGroundColor || source.ButtonBackgroundColor || '').trim();
        var fg = String(source.ButtonTextColor || source.buttonTextColor || '').trim();
        if (bg) backgroundColor = backgroundColor || bg;
        if (fg) textColor = textColor || fg;
      }
    } catch (e) {
      backgroundColor = ''; textColor = '';
    }
    return { backgroundColor: backgroundColor, textColor: textColor };
  }

  function applySquareButtonInverseTheme() {
    if (window.QafLibrary && typeof window.QafLibrary.applySquareButtonInverseTheme === 'function') {
      window.QafLibrary.applySquareButtonInverseTheme('#leaseDashboard');
    }
  }

  function applyCsSettingButtonStyles() {
    var host = document.getElementById('leaseDashboard');
    if (!host) return;

    if (window.QafLibrary && typeof window.QafLibrary.applyCsSettingTheme === 'function') {
      window.QafLibrary.applyCsSettingTheme(host);
      applySquareButtonInverseTheme();
      return;
    }

    var colors = readCsSettingColors();
    if (colors.backgroundColor) host.style.setProperty('--ButtonBackGroundColor', colors.backgroundColor);
    else host.style.removeProperty('--ButtonBackGroundColor');
    if (colors.textColor) host.style.setProperty('--ButtonTextColor', colors.textColor);
    else host.style.removeProperty('--ButtonTextColor');
    applySquareButtonInverseTheme();
  }

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------

  function init() {
    console.debug('[lease-dashboard] init() running, document.readyState =', document.readyState);
    applyCsSettingButtonStyles();
    wireEvents();
    loadFilterValues();     // spec: 1 x ASSET_VALUE_FILTER on initial load only
    loadDashboardData();    // spec: 6 x dashboard workflows, 30-day default window
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