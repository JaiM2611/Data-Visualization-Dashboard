# Data Visualization Dashboard

PRD-aligned implementation of an advanced data visualization dashboard using React + TypeScript + Vite.

## Implemented (step-by-step phases)

### Phase 1: Foundation
- CSV upload and parsing (PapaParse)
- Column type inference (number/date/boolean/string)
- Data preview table (first 50 rows)

### Phase 2: Core charts
- Widget types: Bar, Line, Area, Pie, KPI, Data Table
- Axis and metric mapping
- Aggregations: sum, avg, count, min, max, median

### Phase 3: Dashboard builder
- Widget palette to add cards
- Per-widget configuration panel
- Reorder and remove widgets
- Undo/redo history (Ctrl/Cmd+Z, Ctrl/Cmd+Y)

### Phase 4: Filtering & real-time updates
- Global filter panel with numeric/date/boolean/string modes
- Live chart/table recomputation from filtered dataset
- Filtered row count status

### Phase 5 (local persistence + share-ready stub)
- Save/load dashboard state in localStorage
- Share link generation (client-side stub) with clipboard copy

### UX and accessibility baseline
- Light/dark theme toggle
- Keyboard shortcuts for save and undo/redo
- ARIA live status region for update feedback

## Run locally

```bash
npm install
npm run dev
```

## Validate

```bash
npm run lint
npm run build
```
