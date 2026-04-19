import { useEffect, useMemo, useRef, useState } from 'react'
import Papa from 'papaparse'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core'
import {
  Responsive,
  WidthProvider,
  type Layout,
  type LayoutItem,
  type ResponsiveLayouts,
} from 'react-grid-layout/legacy'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import './App.css'

type Primitive = string | number | boolean | null
type Row = Record<string, Primitive>
type ColumnType = 'number' | 'date' | 'boolean' | 'string'
type WidgetType = 'bar' | 'line' | 'area' | 'pie' | 'kpi' | 'table'
type Aggregation = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'median'
type BreakpointKey = 'xl' | 'md' | 'sm'

interface ColumnMeta {
  name: string
  type: ColumnType
}

interface WidgetConfig {
  id: string
  type: WidgetType
  title: string
  xAxis: string
  yAxis: string
  aggregation: Aggregation
}

type LayoutMap = Record<BreakpointKey, LayoutItem[]>

interface DashboardSnapshot {
  widgets: WidgetConfig[]
  layouts: LayoutMap
}

interface DashboardState {
  rows: Row[]
  columns: ColumnMeta[]
  widgets: WidgetConfig[]
  layouts: LayoutMap
  fileName: string
  filter: FilterState
  theme: Theme
}

interface FilterState {
  column: string
  operator: string
  value: string
  valueTo: string
}

type Theme = 'light' | 'dark'

const ResponsiveGridLayout = WidthProvider(Responsive)

const DASHBOARD_STORAGE_KEY = 'data-viz-dashboard-v2'
const LEGACY_STORAGE_KEY = 'data-viz-dashboard-v1'
const PIE_COLORS = ['#4f46e5', '#f97316', '#14b8a6', '#dc2626', '#eab308', '#0ea5e9', '#8b5cf6', '#22c55e']
const aggregations: Aggregation[] = ['sum', 'avg', 'count', 'min', 'max', 'median']
const widgetPalette: WidgetType[] = ['bar', 'line', 'area', 'pie', 'kpi', 'table']
const BREAKPOINTS: Record<BreakpointKey, number> = { xl: 1200, md: 768, sm: 375 }
const COLS: Record<BreakpointKey, number> = { xl: 12, md: 12, sm: 12 }
const GRID_MARGIN: [number, number] = [12, 12]
const GRID_PADDING: [number, number] = [12, 12]
const DEFAULT_W = 4
const DEFAULT_H = 3
const MIN_W = 2
const MIN_H = 2
const ROW_HEIGHT = 46
const initialSnapshot: DashboardSnapshot = { widgets: [], layouts: emptyLayouts() }

function makeId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `widget-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function normalizeValue(value: unknown): Primitive {
  if (value === '' || value === undefined || value === null) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return String(value).trim()
}

function isDateLike(value: Primitive): boolean {
  if (typeof value !== 'string') return false
  const t = Date.parse(value)
  return Number.isFinite(t)
}

function inferType(values: Primitive[]): ColumnType {
  const defined = values.filter((value) => value !== null)
  if (defined.length === 0) return 'string'

  if (defined.every((value) => typeof value === 'number')) return 'number'
  if (defined.every((value) => typeof value === 'boolean')) return 'boolean'

  const numericLike = defined.every((value) => {
    if (typeof value === 'number') return true
    if (typeof value !== 'string') return false
    return value.length > 0 && Number.isFinite(Number(value))
  })
  if (numericLike) return 'number'

  const dateLikeCount = defined.filter((value) => isDateLike(value)).length
  if (dateLikeCount / defined.length > 0.8) return 'date'

  return 'string'
}

function inferColumns(rows: Row[]): ColumnMeta[] {
  if (!rows.length) return []
  const names = Object.keys(rows[0])
  return names.map((name) => {
    const values = rows.slice(0, 500).map((row) => row[name] ?? null)
    return { name, type: inferType(values) }
  })
}

function toNumber(value: Primitive): number | null {
  if (value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function aggregate(values: number[], mode: Aggregation): number {
  if (mode === 'count') return values.length
  if (!values.length) return 0

  if (mode === 'sum') return values.reduce((acc, value) => acc + value, 0)
  if (mode === 'avg') return values.reduce((acc, value) => acc + value, 0) / values.length
  if (mode === 'min') return Math.min(...values)
  if (mode === 'max') return Math.max(...values)

  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2
  return sorted[mid]
}

function defaultFilterForColumn(column: ColumnMeta | undefined): FilterState {
  if (!column) return { column: '', operator: '=', value: '', valueTo: '' }
  if (column.type === 'number') return { column: column.name, operator: 'between', value: '', valueTo: '' }
  if (column.type === 'date') return { column: column.name, operator: 'between', value: '', valueTo: '' }
  if (column.type === 'boolean') return { column: column.name, operator: '=', value: 'true', valueTo: '' }
  return { column: column.name, operator: 'contains', value: '', valueTo: '' }
}

function applyFilter(row: Row, column: ColumnMeta | undefined, filter: FilterState): boolean {
  if (!column || !filter.column || !filter.value.trim()) return true

  const raw = row[filter.column] ?? null

  if (column.type === 'number') {
    const current = toNumber(raw)
    const min = Number(filter.value)
    const max = Number(filter.valueTo)
    if (current === null || Number.isNaN(min)) return false
    if (filter.operator === '>') return current > min
    if (filter.operator === '<') return current < min
    if (filter.operator === '>=') return current >= min
    if (filter.operator === '<=') return current <= min
    if (filter.operator === '=') return current === min
    if (filter.operator === 'between') {
      if (Number.isNaN(max)) return current >= min
      return current >= min && current <= max
    }
    return true
  }

  if (column.type === 'date') {
    const current = raw ? Date.parse(String(raw)) : NaN
    const from = Date.parse(filter.value)
    if (!Number.isFinite(current) || !Number.isFinite(from)) return false
    if (filter.operator === '>=') return current >= from
    if (filter.operator === '<=') return current <= from
    if (filter.operator === '=') return current === from
    if (filter.operator === 'between') {
      const to = Date.parse(filter.valueTo)
      if (!Number.isFinite(to)) return current >= from
      return current >= from && current <= to
    }
    return true
  }

  if (column.type === 'boolean') {
    const wanted = filter.value === 'true'
    return Boolean(raw) === wanted
  }

  const current = String(raw ?? '').toLowerCase()
  const wanted = filter.value.toLowerCase()
  if (filter.operator === '=') return current === wanted
  return current.includes(wanted)
}

function chartSuggestions(columns: ColumnMeta[]) {
  const numeric = columns.filter((column) => column.type === 'number').length
  const dates = columns.filter((column) => column.type === 'date').length
  const strings = columns.filter((column) => column.type === 'string').length

  const suggestions: string[] = []
  if (dates >= 1 && numeric >= 1) suggestions.push('Line chart for trend analysis')
  if (strings >= 1 && numeric >= 1) suggestions.push('Bar chart for category comparisons')
  if (strings >= 1 && numeric >= 1) suggestions.push('Pie chart for part-to-whole breakdown')
  if (numeric >= 1) suggestions.push('KPI card for top-level metric')
  return suggestions.slice(0, 3)
}

function emptyWidget(type: WidgetType, columns: ColumnMeta[]): WidgetConfig {
  const xCandidate = columns.find((column) => column.type !== 'number')?.name ?? columns[0]?.name ?? ''
  const yCandidate = columns.find((column) => column.type === 'number')?.name ?? columns[0]?.name ?? ''

  return {
    id: makeId(),
    type,
    title: `${type.toUpperCase()} widget`,
    xAxis: type === 'kpi' ? '' : xCandidate,
    yAxis: yCandidate,
    aggregation: type === 'table' ? 'count' : 'sum',
  }
}

function emptyLayouts(): LayoutMap {
  return { xl: [], md: [], sm: [] }
}

function cloneLayouts(layouts: LayoutMap): LayoutMap {
  return {
    xl: layouts.xl.map((item) => ({ ...item })),
    md: layouts.md.map((item) => ({ ...item })),
    sm: layouts.sm.map((item) => ({ ...item })),
  }
}

function clampX(x: number, cols = COLS.xl, w = DEFAULT_W) {
  return Math.min(Math.max(x, 0), Math.max(cols - w, 0))
}

function normalizeLayoutItem(item: LayoutItem, breakpoint: BreakpointKey): LayoutItem {
  const cols = COLS[breakpoint]
  const safeW = Math.min(Math.max(item.w ?? DEFAULT_W, MIN_W), cols)
  const safeX = clampX(item.x ?? 0, cols, safeW)
  const safeH = Math.max(item.h ?? DEFAULT_H, MIN_H)
  return { ...item, x: safeX, y: item.y ?? 0, w: safeW, h: safeH, minW: MIN_W, minH: MIN_H }
}

function alignLayouts(
  layouts: Partial<Record<BreakpointKey, Layout | LayoutItem[]>> | ResponsiveLayouts<BreakpointKey> | undefined,
  widgets: WidgetConfig[],
): LayoutMap {
  const ids = new Set(widgets.map((widget) => widget.id))
  return (['xl', 'md', 'sm'] as BreakpointKey[]).reduce((acc, breakpoint) => {
    const base = [...((layouts?.[breakpoint] as LayoutItem[] | Layout | undefined) ?? [])]
    const filtered = base.filter((item) => ids.has(item.i)).map((item) => normalizeLayoutItem(item, breakpoint))
    const missing = widgets
      .filter((widget) => !filtered.some((item) => item.i === widget.id))
      .map((widget) =>
        normalizeLayoutItem(
          { i: widget.id, x: 0, y: Infinity, w: DEFAULT_W, h: DEFAULT_H, minW: MIN_W, minH: MIN_H },
          breakpoint,
        ),
      )
    acc[breakpoint] = [...filtered, ...missing]
    return acc
  }, {} as LayoutMap)
}

function addWidgetToLayouts(layouts: LayoutMap, widgetId: string, placement?: { breakpoint: BreakpointKey; x: number; y: number }) {
  const next = cloneLayouts(layouts)
  ;(['xl', 'md', 'sm'] as BreakpointKey[]).forEach((breakpoint) => {
    const isPlacement = placement && placement.breakpoint === breakpoint
    const item = normalizeLayoutItem(
      {
        i: widgetId,
        x: isPlacement ? placement.x : 0,
        y: isPlacement ? placement.y : Infinity,
        w: DEFAULT_W,
        h: DEFAULT_H,
        minW: MIN_W,
        minH: MIN_H,
      },
      breakpoint,
    )
    next[breakpoint] = [...next[breakpoint], item]
  })
  return next
}

function removeWidgetFromLayouts(layouts: LayoutMap, widgetId: string) {
  return (['xl', 'md', 'sm'] as BreakpointKey[]).reduce((acc, breakpoint) => {
    acc[breakpoint] = layouts[breakpoint].filter((item) => item.i !== widgetId)
    return acc
  }, {} as LayoutMap)
}

function normalizeSnapshot(snapshot: DashboardSnapshot): DashboardSnapshot {
  return {
    widgets: snapshot.widgets,
    layouts: alignLayouts(snapshot.layouts, snapshot.widgets),
  }
}

function columnWidth(containerWidth: number, breakpoint: BreakpointKey) {
  const cols = COLS[breakpoint]
  return (containerWidth - GRID_MARGIN[0] * (cols - 1) - GRID_PADDING[0] * 2) / cols
}

function gridFromPoint(
  point: { x: number; y: number },
  rect: DOMRect,
  breakpoint: BreakpointKey,
): { x: number; y: number } {
  const cols = COLS[breakpoint]
  const colWidth = columnWidth(rect.width, breakpoint)
  const relativeX = point.x - rect.left - GRID_PADDING[0]
  const relativeY = point.y - rect.top - GRID_PADDING[1]
  const x = clampX(Math.floor(relativeX / (colWidth + GRID_MARGIN[0])), cols, DEFAULT_W)
  const y = Math.max(0, Math.floor(relativeY / (ROW_HEIGHT + GRID_MARGIN[1])))
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 }
}

interface PaletteButtonProps {
  type: WidgetType
  disabled: boolean
  onAdd: () => void
}

function PaletteButton({ type, disabled, onAdd }: PaletteButtonProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${type}`,
    data: { type },
    disabled,
  })

  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`palette-item ${isDragging ? 'dragging' : ''}`}
      onClick={onAdd}
      disabled={disabled}
      {...attributes}
      {...listeners}
    >
      + {type.toUpperCase()}
    </button>
  )
}

function App() {
  const [rows, setRows] = useState<Row[]>([])
  const [columns, setColumns] = useState<ColumnMeta[]>([])
  const [fileName, setFileName] = useState('')
  const [history, setHistory] = useState<DashboardSnapshot[]>([initialSnapshot])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [filter, setFilter] = useState<FilterState>({ column: '', operator: '=', value: '', valueTo: '' })
  const [theme, setTheme] = useState<Theme>('light')
  const [shareLink, setShareLink] = useState('')
  const [status, setStatus] = useState('Ready.')
  const [currentBreakpoint, setCurrentBreakpoint] = useState<BreakpointKey>('xl')
  const [dropPreview, setDropPreview] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null,
  )

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const layoutDraftRef = useRef<LayoutMap>(initialSnapshot.layouts)
  const widgetsRef = useRef<WidgetConfig[]>([])

  const currentSnapshot = history[historyIndex] ?? initialSnapshot
  const widgets = currentSnapshot.widgets
  const layouts = currentSnapshot.layouts

  const selectedColumn = columns.find((column) => column.name === filter.column)
  const suggestions = useMemo(() => chartSuggestions(columns), [columns])
  const isSharedView = useMemo(() => new URLSearchParams(window.location.search).has('share'), [])

  const canUndo = historyIndex > 0
  const canRedo = historyIndex < history.length - 1

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    widgetsRef.current = widgets
  }, [widgets])

  useEffect(() => {
    layoutDraftRef.current = layouts
  }, [layouts])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (canUndo) setHistoryIndex((index) => index - 1)
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        if (canRedo) setHistoryIndex((index) => index + 1)
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        const state: DashboardState = {
          rows,
          columns,
          widgets,
          layouts,
          fileName,
          filter,
          theme,
        }
        localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(state))
        setStatus(`Saved ${new Date().toLocaleTimeString()}`)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canUndo, canRedo, rows, columns, widgets, layouts, fileName, filter, theme])

  const filteredRows = useMemo(
    () => rows.filter((row) => applyFilter(row, selectedColumn, filter)),
    [rows, selectedColumn, filter],
  )

  const updateDashboard = (producer: (current: DashboardSnapshot) => DashboardSnapshot, track = true) => {
    setHistory((previous) => {
      const current = previous[historyIndex] ?? initialSnapshot
      const next = normalizeSnapshot(producer(current))

      if (!track) {
        return previous.map((entry, index) => (index === historyIndex ? next : entry))
      }

      const nextHistory = previous.slice(0, historyIndex + 1)
      nextHistory.push(next)
      setHistoryIndex(nextHistory.length - 1)
      return nextHistory
    })
  }

  function saveDashboard() {
    const state: DashboardState = {
      rows,
      columns,
      widgets,
      layouts,
      fileName,
      filter,
      theme,
    }
    localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(state))
    setStatus(`Saved ${new Date().toLocaleTimeString()}`)
  }

  const loadDashboard = () => {
    const saved = localStorage.getItem(DASHBOARD_STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!saved) {
      setStatus('No saved dashboard found.')
      return
    }

    try {
      const parsed = JSON.parse(saved) as DashboardState
      const restoredWidgets = Array.isArray(parsed.widgets) ? parsed.widgets : []
      const restoredLayouts = alignLayouts(parsed.layouts, restoredWidgets)
      setRows(Array.isArray(parsed.rows) ? parsed.rows : [])
      setColumns(Array.isArray(parsed.columns) ? parsed.columns : [])
      setFileName(parsed.fileName ?? '')
      setFilter(parsed.filter ?? { column: '', operator: '=', value: '', valueTo: '' })
      setTheme(parsed.theme === 'dark' ? 'dark' : 'light')
      setHistory([normalizeSnapshot({ widgets: restoredWidgets, layouts: restoredLayouts })])
      setHistoryIndex(0)
      setStatus(`Loaded ${new Date().toLocaleTimeString()}`)
    } catch {
      setStatus('Saved dashboard is invalid.')
    }
  }

  const parseCsv = (file: File) => {
    Papa.parse<Record<string, unknown>>(file, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: (result) => {
        if (result.errors.length) {
          setStatus(`Parsing error: ${result.errors[0].message}`)
          return
        }

        const normalizedRows = result.data
          .map((row) => {
            const normalized: Row = {}
            Object.entries(row).forEach(([key, value]) => {
              normalized[key] = normalizeValue(value)
            })
            return normalized
          })
          .filter((row) => Object.values(row).some((value) => value !== null))

        const inferredColumns = inferColumns(normalizedRows)
        setRows(normalizedRows)
        setColumns(inferredColumns)
        setFileName(file.name)
        setFilter(defaultFilterForColumn(inferredColumns[0]))
        setStatus(`Loaded ${normalizedRows.length.toLocaleString()} rows from ${file.name}`)
      },
    })
  }

  const addWidget = (type: WidgetType, placement?: { breakpoint: BreakpointKey; x: number; y: number }) => {
    if (!columns.length) {
      setStatus('Upload a dataset first.')
      return
    }

    updateDashboard((current) => {
      const widget = emptyWidget(type, columns)
      const nextLayouts = addWidgetToLayouts(current.layouts, widget.id, placement)
      return { widgets: [...current.widgets, widget], layouts: nextLayouts }
    })
    setStatus(`Added ${type} widget.`)
  }

  const updateWidget = (id: string, updates: Partial<WidgetConfig>) => {
    updateDashboard((current) => ({
      widgets: current.widgets.map((widget) => (widget.id === id ? { ...widget, ...updates } : widget)),
      layouts: current.layouts,
    }))
  }

  const removeWidget = (id: string) => {
    updateDashboard((current) => ({
      widgets: current.widgets.filter((widget) => widget.id !== id),
      layouts: removeWidgetFromLayouts(current.layouts, id),
    }))
  }

  const createShareLink = async () => {
    const token = makeId().slice(0, 8)
    const link = `${window.location.origin}${window.location.pathname}?share=${token}`
    setShareLink(link)
    try {
      await navigator.clipboard.writeText(link)
      setStatus('Share link copied to clipboard.')
    } catch {
      setStatus('Share link created.')
    }
  }

  const renderChart = (widget: WidgetConfig) => {
    if (widget.type === 'table') {
      const topRows = filteredRows.slice(0, 20)
      return (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.name}>{column.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {topRows.map((row, index) => (
                <tr key={`${widget.id}-${index}`}>
                  {columns.map((column) => (
                    <td key={`${widget.id}-${index}-${column.name}`}>{String(row[column.name] ?? '—')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }

    if (!widget.yAxis) return <p className="placeholder">Select a metric column to render this widget.</p>

    if (widget.type === 'kpi') {
      const values = filteredRows.map((row) => toNumber(row[widget.yAxis])).filter((value): value is number => value !== null)
      const value = aggregate(values, widget.aggregation)
      return (
        <div className="kpi">
          <span>Aggregation</span>
          <strong>{widget.aggregation.toUpperCase()}</strong>
          <h3>{widget.yAxis}</h3>
          <p>{value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
        </div>
      )
    }

    if (!widget.xAxis) return <p className="placeholder">Select both X and Y axis columns.</p>

    const grouped = new Map<string, number[]>()
    filteredRows.forEach((row) => {
      const xRaw = row[widget.xAxis]
      const key = xRaw === null ? 'Null' : String(xRaw)
      const y = toNumber(row[widget.yAxis])
      if (y === null && widget.aggregation !== 'count') return
      const existing = grouped.get(key) ?? []
      if (widget.aggregation === 'count') {
        existing.push(1)
      } else {
        existing.push(y ?? 0)
      }
      grouped.set(key, existing)
    })

    const data = [...grouped.entries()].map(([name, values]) => ({
      name,
      value: aggregate(values, widget.aggregation),
    }))

    if (!data.length) return <p className="placeholder">No data available for current filters.</p>

    if (widget.type === 'bar') {
      return (
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis />
            <Tooltip />
            <Legend />
            <Bar dataKey="value" fill="#4f46e5" />
          </BarChart>
        </ResponsiveContainer>
      )
    }

    if (widget.type === 'line') {
      return (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis />
            <Tooltip />
            <Legend />
            <Line dataKey="value" stroke="#0891b2" type="monotone" strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      )
    }

    if (widget.type === 'area') {
      return (
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis />
            <Tooltip />
            <Legend />
            <Area dataKey="value" stroke="#16a34a" fill="#86efac" type="monotone" />
          </AreaChart>
        </ResponsiveContainer>
      )
    }

    return (
      <ResponsiveContainer width="100%" height={240}>
        <PieChart>
          <Tooltip />
          <Legend />
          <Pie data={data} dataKey="value" nameKey="name" outerRadius={80} label>
            {data.map((entry, index) => (
              <Cell key={`${entry.name}-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    )
  }

  const { setNodeRef, isOver } = useDroppable({
    id: 'canvas-drop',
    disabled: isSharedView || !columns.length,
  })

  const keyboardCoordinates: KeyboardCoordinateGetter = (event, { currentCoordinates }) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    const colWidth = rect ? columnWidth(rect.width, currentBreakpoint) + GRID_MARGIN[0] : 80
    const rowStep = ROW_HEIGHT + GRID_MARGIN[1]
    const coords = currentCoordinates ?? { x: GRID_PADDING[0], y: GRID_PADDING[1] }

    if (event.code === 'ArrowRight') return { ...coords, x: coords.x + colWidth }
    if (event.code === 'ArrowLeft') return { ...coords, x: coords.x - colWidth }
    if (event.code === 'ArrowDown') return { ...coords, y: coords.y + rowStep }
    if (event.code === 'ArrowUp') return { ...coords, y: coords.y - rowStep }
    return undefined
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }),
  )

  const handleDragMove = (event: DragMoveEvent) => {
    const type = event.active.data.current?.type as WidgetType | undefined
    if (!type || isSharedView || !columns.length) {
      setDropPreview(null)
      return
    }
    if (event.over?.id !== 'canvas-drop') {
      setDropPreview(null)
      return
    }

    const initial = event.active.rect.current?.initial
    const containerRect = canvasRef.current?.getBoundingClientRect()

    if (!initial || !containerRect) {
      setDropPreview(null)
      return
    }

    const dropCenter = {
      x: initial.left + event.delta.x + initial.width / 2,
      y: initial.top + event.delta.y + initial.height / 2,
    }

    const { x, y } = gridFromPoint(dropCenter, containerRect, currentBreakpoint)
    const colWidth = columnWidth(containerRect.width, currentBreakpoint)
    const width = DEFAULT_W * colWidth + GRID_MARGIN[0] * (DEFAULT_W - 1)
    const height = DEFAULT_H * ROW_HEIGHT + GRID_MARGIN[1] * (DEFAULT_H - 1)
    const left = GRID_PADDING[0] + x * (colWidth + GRID_MARGIN[0])
    const top = GRID_PADDING[1] + y * (ROW_HEIGHT + GRID_MARGIN[1])

    if (!Number.isFinite(left) || !Number.isFinite(top)) {
      setDropPreview(null)
      return
    }

    setDropPreview({ left, top, width, height })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setDropPreview(null)
    const type = event.active.data.current?.type as WidgetType | undefined
    if (!type || isSharedView) return
    if (!columns.length) {
      setStatus('Upload a dataset first.')
      return
    }
    if (event.over?.id !== 'canvas-drop') {
      setStatus('Drag onto the canvas to place a widget.')
      return
    }

    const initial = event.active.rect.current?.initial
    const containerRect = canvasRef.current?.getBoundingClientRect()

    if (!initial || !containerRect) {
      addWidget(type)
      return
    }

    const dropCenter = {
      x: initial.left + event.delta.x + initial.width / 2,
      y: initial.top + event.delta.y + initial.height / 2,
    }

    const { x, y } = gridFromPoint(dropCenter, containerRect, currentBreakpoint)
    addWidget(type, { breakpoint: currentBreakpoint, x, y })
  }

  const handleLayoutChange = (_layout: Layout, allLayouts: ResponsiveLayouts<BreakpointKey>) => {
    layoutDraftRef.current = alignLayouts(allLayouts, widgetsRef.current)
  }

  const commitLayoutChange = () => {
    const nextLayouts = layoutDraftRef.current
    updateDashboard((current) => ({
      widgets: current.widgets,
      layouts: alignLayouts(nextLayouts, current.widgets),
    }))
    setStatus('Layout updated.')
  }

  return (
    <main className="app">
      <header className="top-bar">
        <div>
          <h1>Advanced Data Visualization Dashboard</h1>
          <p>PRD-driven phased implementation: upload data, configure charts, apply filters, save, and share.</p>
        </div>

        <div className="toolbar">
          <button type="button" onClick={() => setTheme((mode) => (mode === 'light' ? 'dark' : 'light'))}>
            Theme: {theme}
          </button>
          <button type="button" onClick={saveDashboard}>Save</button>
          <button type="button" onClick={loadDashboard}>Load</button>
          <button type="button" onClick={createShareLink}>Share</button>
        </div>
      </header>

      <section className="panel">
        <h2>1) Upload Dataset (CSV)</h2>
        <div className="uploader">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) parseCsv(file)
            }}
            disabled={isSharedView}
          />
          <span>{fileName ? `Current dataset: ${fileName}` : 'No dataset loaded'}</span>
        </div>

        {columns.length > 0 && (
          <div className="metadata">
            {columns.map((column) => (
              <span key={column.name} className={`badge ${column.type}`}>
                {column.name} · {column.type}
              </span>
            ))}
          </div>
        )}

        {suggestions.length > 0 && (
          <ul className="suggestions">
            {suggestions.map((suggestion) => (
              <li key={suggestion}>{suggestion}</li>
            ))}
          </ul>
        )}

        {rows.length > 0 && (
          <div className="preview table-wrap">
            <h3>Data Preview (first 50 rows)</h3>
            <table>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column.name}>{column.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 50).map((row, index) => (
                  <tr key={`preview-${index}`}>
                    {columns.map((column) => (
                      <td key={`preview-${index}-${column.name}`} className={row[column.name] === null ? 'null' : ''}>
                        {String(row[column.name] ?? 'NULL')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>2) Global Filter Panel</h2>
        <div className="filter-grid">
          <label>
            Column
            <select
              value={filter.column}
              onChange={(event) => {
                const next = columns.find((column) => column.name === event.target.value)
                setFilter(defaultFilterForColumn(next))
              }}
              disabled={isSharedView}
            >
              <option value="">None</option>
              {columns.map((column) => (
                <option key={column.name} value={column.name}>
                  {column.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Operator
            <select
              value={filter.operator}
              onChange={(event) => setFilter((previous) => ({ ...previous, operator: event.target.value }))}
              disabled={isSharedView || !selectedColumn}
            >
              {selectedColumn?.type === 'number' && (
                <>
                  <option value=">">&gt;</option>
                  <option value="<">&lt;</option>
                  <option value=">=">&gt;=</option>
                  <option value="<=">&lt;=</option>
                  <option value="=">=</option>
                  <option value="between">between</option>
                </>
              )}
              {selectedColumn?.type === 'date' && (
                <>
                  <option value=">=">after/on</option>
                  <option value="<=">before/on</option>
                  <option value="=">exact</option>
                  <option value="between">between</option>
                </>
              )}
              {selectedColumn?.type === 'string' && (
                <>
                  <option value="contains">contains</option>
                  <option value="=">equals</option>
                </>
              )}
              {selectedColumn?.type === 'boolean' && <option value="=">equals</option>}
              {!selectedColumn && <option value="=">=</option>}
            </select>
          </label>

          <label>
            Value
            <input
              type={selectedColumn?.type === 'date' ? 'date' : selectedColumn?.type === 'number' ? 'number' : 'text'}
              value={filter.value}
              onChange={(event) => setFilter((previous) => ({ ...previous, value: event.target.value }))}
              disabled={isSharedView || !selectedColumn}
            />
          </label>

          {(selectedColumn?.type === 'number' || selectedColumn?.type === 'date') && filter.operator === 'between' && (
            <label>
              Value To
              <input
                type={selectedColumn.type === 'date' ? 'date' : 'number'}
                value={filter.valueTo}
                onChange={(event) => setFilter((previous) => ({ ...previous, valueTo: event.target.value }))}
                disabled={isSharedView}
              />
            </label>
          )}

          {selectedColumn?.type === 'boolean' && (
            <label>
              Boolean Value
              <select
                value={filter.value}
                onChange={(event) => setFilter((previous) => ({ ...previous, value: event.target.value }))}
                disabled={isSharedView}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>
          )}
        </div>

        <p className="status">
          Filtered rows: {filteredRows.length.toLocaleString()} / {rows.length.toLocaleString()}
        </p>
      </section>

      <section className="panel">
        <h2>3) Dashboard Builder</h2>

        <DndContext
          sensors={sensors}
          onDragMove={handleDragMove}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDropPreview(null)}
        >
          <div className="builder-shell">
            <div className="palette" aria-label="Widget palette">
              <div className="palette-grid">
                {widgetPalette.map((type) => (
                  <PaletteButton
                    key={type}
                    type={type}
                    disabled={isSharedView || !columns.length}
                    onAdd={() => addWidget(type)}
                  />
                ))}
              </div>
              <p className="palette-hint">
                Drag from the palette onto the grid. Keyboard: focus a tile, press Space/Enter, use arrows, press Space to
                drop.
              </p>
              <div className="palette-actions">
                <button type="button" onClick={() => canUndo && setHistoryIndex((index) => index - 1)} disabled={!canUndo}>
                  Undo
                </button>
                <button type="button" onClick={() => canRedo && setHistoryIndex((index) => index + 1)} disabled={!canRedo}>
                  Redo
                </button>
              </div>
            </div>

            <div
              className={`canvas ${isOver ? 'canvas-over' : ''}`}
              ref={(node) => {
                setNodeRef(node)
                canvasRef.current = node
              }}
            >
              {!widgets.length && <p className="placeholder">Drag widgets here or click a palette button to start.</p>}
              {dropPreview && (
                <div
                  aria-hidden="true"
                  className="drop-preview"
                  style={{
                    left: `${dropPreview.left}px`,
                    top: `${dropPreview.top}px`,
                    width: `${dropPreview.width}px`,
                    height: `${dropPreview.height}px`,
                  }}
                />
              )}

              <ResponsiveGridLayout
                className="grid-layout"
                layouts={layouts}
                breakpoints={BREAKPOINTS}
                cols={COLS}
                rowHeight={ROW_HEIGHT}
                margin={GRID_MARGIN}
                containerPadding={GRID_PADDING}
                compactType="vertical"
                isDraggable={!isSharedView && !!columns.length}
                isResizable={!isSharedView && !!columns.length}
                preventCollision={false}
                onLayoutChange={handleLayoutChange}
                onDragStop={commitLayoutChange}
                onResizeStop={commitLayoutChange}
                onBreakpointChange={(next: string) => setCurrentBreakpoint(next as BreakpointKey)}
                draggableHandle=".widget-drag-handle"
                measureBeforeMount
                useCSSTransforms
              >
                {widgets.map((widget) => (
                  <div key={widget.id} className="widget-card">
                    <header>
                      <div className="widget-title-row">
                        <span className="widget-drag-handle" aria-hidden="true">
                          ⋮⋮
                        </span>
                        <input
                          value={widget.title}
                          onChange={(event) => updateWidget(widget.id, { title: event.target.value })}
                          disabled={isSharedView}
                          aria-label="Widget title"
                        />
                      </div>

                      <div className="widget-actions">
                        <button type="button" onClick={() => removeWidget(widget.id)} disabled={isSharedView}>
                          Remove
                        </button>
                      </div>
                    </header>

                    <div className="config-grid">
                      <label>
                        Type
                        <select
                          value={widget.type}
                          onChange={(event) => updateWidget(widget.id, { type: event.target.value as WidgetType })}
                          disabled={isSharedView}
                        >
                          {widgetPalette.map((type) => (
                            <option key={type} value={type}>
                              {type}
                            </option>
                          ))}
                        </select>
                      </label>

                      {widget.type !== 'kpi' && (
                        <label>
                          X Axis
                          <select
                            value={widget.xAxis}
                            onChange={(event) => updateWidget(widget.id, { xAxis: event.target.value })}
                            disabled={isSharedView}
                          >
                            <option value="">Select</option>
                            {columns.map((column) => (
                              <option key={column.name} value={column.name}>
                                {column.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}

                      <label>
                        Y / Metric
                        <select
                          value={widget.yAxis}
                          onChange={(event) => updateWidget(widget.id, { yAxis: event.target.value })}
                          disabled={isSharedView}
                        >
                          <option value="">Select</option>
                          {columns.map((column) => (
                            <option key={column.name} value={column.name}>
                              {column.name}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label>
                        Aggregation
                        <select
                          value={widget.aggregation}
                          onChange={(event) => updateWidget(widget.id, { aggregation: event.target.value as Aggregation })}
                          disabled={isSharedView}
                        >
                          {aggregations.map((mode) => (
                            <option key={mode} value={mode}>
                              {mode}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    {renderChart(widget)}
                  </div>
                ))}
              </ResponsiveGridLayout>
            </div>
          </div>
        </DndContext>
      </section>

      {shareLink && (
        <section className="panel">
          <h2>Share Link</h2>
          <p className="share-link">{shareLink}</p>
        </section>
      )}

      <footer className="status" role="status" aria-live="polite">
        {status}
      </footer>
    </main>
  )
}

export default App
