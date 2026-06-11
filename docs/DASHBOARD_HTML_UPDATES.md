# Admin Dashboard HTML Updates

Required changes to `pages/admin-dashboard.html` to support enhanced filtering system.

## Summary of Changes

Three new elements needed:
1. **Dataset selector** in filter toolbar
2. **Data source label** near metrics
3. **Dataset indicator** to show active selection

---

## Updated Filter Section

**Location**: In the "Experience Filters" form (replace/enhance existing toolbar)

**Current HTML** (line ~5):
```html
<section class="panel"><div class="section-head"><h2>Experience Filters</h2><p id="qb-filter-summary">All synced time data</p></div><form id="qb-viz-filters" class="toolbar">
```

**Enhanced HTML**:
```html
<section class="panel">
  <div class="section-head">
    <h2>Experience Filters</h2>
    <p id="qb-filter-summary">All synced time data</p>
    <p id="data-source-label">Data shown across all datasets</p>
  </div>
  <form id="qb-viz-filters" class="toolbar">
    <!-- NEW: Dataset Selection -->
    <label>
      Dataset
      <select id="filter-dataset"></select>
    </label>
    
    <!-- EXISTING: Keyword filter -->
    <label>
      Keyword
      <input id="filter-keyword" type="text" placeholder="Search text">
    </label>
    
    <!-- EXISTING: Other filters continue as before -->
    <label>
      Employee
      <select id="filter-employee"></select>
    </label>
    
    <label>
      Start Date
      <input id="filter-start" type="date">
    </label>
    
    <label>
      End Date
      <input id="filter-end" type="date">
    </label>
    
    <label>
      Job Code Level 1
      <select id="filter-jobcode-1"></select>
    </label>
    
    <label>
      Job Code Level 2
      <select id="filter-jobcode-2"></select>
    </label>
    
    <label>
      Job Code Level 3
      <select id="filter-jobcode-3"></select>
    </label>
    
    <label>
      Service Item
      <select id="filter-service-item"></select>
    </label>
    
    <!-- Buttons -->
    <button type="submit" id="apply-filters">Apply Filters</button>
    <button type="button" id="clear-qb-filters" class="secondary">Clear</button>
  </form>
</section>
```

---

## Add Dataset Indicator

**Location**: Top of dashboard, near metrics section (before the four-column grid)

**HTML to add** (after the `<div class="topbar">` section):
```html
<!-- Dataset Indicator -->
<div id="dataset-indicator" class="hidden panel info">
  <span>✓ Viewing: [Dataset Name] ([Record Count] records)</span>
</div>
```

**With CSS styling** (add to `css/styles.css` if not present):
```css
.panel.info {
  background-color: #e8f4f8;
  border-left: 4px solid #0891b2;
  padding: 12px 16px;
  margin-bottom: 16px;
  border-radius: 4px;
}

.panel.info span {
  color: #0c5460;
  font-weight: 500;
}

.hidden {
  display: none;
}
```

---

## Full Updated Metrics Section

**Location**: Line ~4, the four-column metrics grid

**Current structure preserved, but updated with dataset awareness**:

```html
<!-- Metrics Grid -->
<section class="grid four">
  <div class="metric">
    <strong id="metric-hours">-</strong>
    <span>Total hours</span>
  </div>
  <div class="metric">
    <strong id="metric-timesheets">-</strong>
    <span>Timesheets</span>
  </div>
  <div class="metric">
    <strong id="metric-employees">-</strong>
    <span>Unique employees</span>
  </div>
  <div class="metric">
    <strong id="metric-services">-</strong>
    <span>Service items</span>
  </div>
</section>

<!-- Data Coverage Grid (unchanged) -->
<section class="grid four">
  <div class="metric">
    <strong id="metric-users">-</strong>
    <span>Users</span>
  </div>
  <div class="metric">
    <strong id="metric-datasets">-</strong>
    <span>Datasets</span>
  </div>
  <div class="metric">
    <strong id="metric-records">-</strong>
    <span>Total records</span>
  </div>
  <div class="metric">
    <strong id="metric-keys">-</strong>
    <span>API keys</span>
  </div>
</section>
```

---

## Element ID Reference

Ensure these IDs exist in the HTML:

### Filter Inputs
- `#filter-dataset` ← **NEW**
- `#filter-keyword` (existing)
- `#filter-employee` (existing)
- `#filter-start` (existing)
- `#filter-end` (existing)
- `#filter-jobcode-1` (existing)
- `#filter-jobcode-2` (existing)
- `#filter-jobcode-3` (existing)
- `#filter-service-item` (existing)

### Filter Controls
- `#qb-viz-filters` (existing form)
- `#apply-filters` or `[type="submit"]` (existing)
- `#clear-qb-filters` (existing)

### Display Elements
- `#qb-filter-summary` (existing, enhanced)
- `#data-source-label` ← **NEW**
- `#dataset-indicator` ← **NEW**

### Metrics
- `#metric-hours` (existing)
- `#metric-timesheets` (existing)
- `#metric-employees` (existing)
- `#metric-services` (existing)
- `#metric-users` (existing)
- `#metric-datasets` (existing)
- `#metric-records` (existing)
- `#metric-keys` (existing)

### Tables (existing, unchanged)
- `#employee-experience-body`
- `#experience-detail-body`
- `#recent-uploads`
- `#recent-syncs`
- `#recent-logs`

### Charts (existing, unchanged)
- `#hours-by-employee`
- `#hours-by-jobcode`
- `#hours-by-service-item`
- `#hours-over-time`
- `#records-by-dataset`
- `#records-over-time`
- `#activity-over-time`

---

## Visual Layout

```
┌─────────────────────────────────────────┐
│   Admin Dashboard                        │
│   [user email]                          │
└─────────────────────────────────────────┘

┌─ Dataset Indicator (shown when dataset selected) ──────────────────┐
│ ✓ Viewing: Proposals (12,345 records)                             │
└────────────────────────────────────────────────────────────────────┘

┌─ Metrics: QB Time ─────────────────────────┐
│  1,045 hrs  │  142 sheets  │  8 emps  │  5 svc  │
└────────────────────────────────────────────┘

┌─ Metrics: Data Coverage ──────────────────┐
│  15 users  │  3 datasets  │  45K records  │  5 keys  │
└────────────────────────────────────────────┘

┌─ Experience Filters ─────────────────────────────────────────────────┐
│                                                                      │
│ Data shown from Proposals                                           │
│ All synced time data                                                │
│                                                                      │
│ ┌─ Filter Form ────────────────────────────────────────────────────┐ │
│ │                                                                  │ │
│ │  Dataset: [Proposals ▼]                                         │ │
│ │                                                                  │ │
│ │  Keyword: [_________]     Employee: [John Smith ▼]            │ │
│ │                                                                  │ │
│ │  Start: [__________]       End: [__________]                   │ │
│ │                                                                  │ │
│ │  Job Code 1: [Development ▼]                                    │ │
│ │  Job Code 2: [Backend ▼]                                        │ │
│ │  Job Code 3: [React ▼]                                          │ │
│ │                                                                  │ │
│ │  Service: [Implementation ▼]                                    │ │
│ │                                                                  │ │
│ │  [Apply Filters]  [Clear]                                       │ │
│ │                                                                  │ │
│ └──────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────┘

┌─ Charts ──────────────────────────────────────────────────────────────┐
│  [Hours by Employee Chart]    [Hours by Job Code Chart]              │
│  [Hours by Service Chart]     [Hours Over Time Chart]                │
└───────────────────────────────────────────────────────────────────────┘

┌─ Employee Experience (8 matching employees) ───────────────────────┐
│  Employee  │ Hours  │ Sheets │ Codes │ Services │ First      │ Last │
├────────────┼────────┼────────┼───────┼──────────┼────────────┼──────┤
│ John Smith │ 145 hrs│   18   │   2   │    1     │ 6/1/2026   │ 6/14 │
│ Jane Doe   │ 132 hrs│   16   │   3   │    1     │ 6/2/2026   │ 6/15 │
│ ...        │ ...    │ ...    │ ...   │ ...      │ ...        │ ...  │
└────────────────────────────────────────────────────────────────────┘

┌─ Job / Service Detail (45 combinations) ───────────────────────────┐
│ Employee   │ L1 Code │ L2 Code │ L3 Code │ Service     │ Hours │ Period │
├────────────┼─────────┼─────────┼─────────┼─────────────┼───────┼────────┤
│ John Smith │ Dev     │ Backend │ React   │ Impl        │ 45 hrs│ 6/1-14 │
│ Jane Doe   │ Dev     │ Backend │ React   │ Impl        │ 50 hrs│ 6/2-15 │
│ ...        │ ...     │ ...     │ ...     │ ...         │ ...   │ ...    │
└────────────────────────────────────────────────────────────────────┘

┌─ Recent Syncs / Activity ──────────────────────────────────────────┐
│  [Status]  │  [Finished]         │  [Message]                     │
│  [Recent Logs Table]                                              │
└───────────────────────────────────────────────────────────────────┘
```

---

## Implementation Checklist

- [ ] Add `#filter-dataset` select element to filter toolbar
- [ ] Add `#data-source-label` paragraph to filter section header
- [ ] Add `#dataset-indicator` div with info styling
- [ ] Verify all filter input IDs match list above
- [ ] Verify all metric IDs match list above
- [ ] Verify all table body IDs match list above
- [ ] Verify all chart canvas IDs match list above
- [ ] Test dataset selector loads and populates
- [ ] Test data-source-label updates on selection
- [ ] Test dataset-indicator appears/disappears correctly
- [ ] Test styling looks professional in light/dark modes

---

## CSS Class Requirements

Verify these CSS classes exist in `css/styles.css`:

```css
/* Required for new elements */
.hidden {
  display: none !important;
}

.panel.info {
  background-color: #e8f4f8;
  border-left: 4px solid #0891b2;
  padding: 12px 16px;
  margin-bottom: 16px;
  border-radius: 4px;
}

.panel.info span {
  color: #0c5460;
  font-weight: 500;
}

/* Existing but verify present */
.toolbar {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.toolbar label {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.toolbar input,
.toolbar select {
  margin-top: 4px;
  padding: 8px 12px;
  border: 1px solid #d0d5dd;
  border-radius: 4px;
  font-size: 14px;
}

.toolbar button {
  margin-top: auto;
}
```

---

## Testing the HTML Changes

**Browser Console Test**:
```javascript
// Verify all new elements exist
console.log(document.getElementById("filter-dataset")); // Should not be null
console.log(document.getElementById("data-source-label")); // Should not be null
console.log(document.getElementById("dataset-indicator")); // Should not be null

// Verify classes
console.log(document.getElementById("dataset-indicator").classList); // Should include "hidden" initially
```

**Visual Test**:
1. Load admin dashboard
2. Verify dataset dropdown appears in filter section
3. Verify data source label shows "Data shown across all datasets"
4. Verify dataset indicator is hidden initially
5. Select a dataset → indicator should appear with dataset info
6. Clear selection → indicator should hide again

---

## Notes for Frontend Team

1. **Maintain responsive design**: Toolbar should stack on mobile, grid on desktop
2. **Accessibility**: Ensure all selects have proper labels
3. **Placeholder text**: Dataset selector should show "All datasets" by default
4. **Disabled state**: None of the QB filter inputs should be disabled by default
5. **Focus management**: Tab order should follow logical filter flow
6. **Error states**: Keep existing error styling for invalid filters
