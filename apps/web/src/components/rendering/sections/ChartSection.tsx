/**
 * ChartSection Component
 * Task: view-builder-implementation
 * Spec: spec-chart-section
 *
 * Visualize data from arbitrary Wavesmith domains as charts and graphs using D3.js.
 * Controllable via chat-driven virtual tools and composable into various use cases.
 *
 * Data bindings:
 * - (configurable).{model}: Primary data source - collection to aggregate and visualize
 *
 * Config options:
 * - schema: string - Schema name to query (e.g., "platform-features")
 * - model: string - Model/collection name (e.g., "Requirement")
 * - chartType: "bar" | "line" - Type of chart to render
 * - xField: string - Property name for x-axis
 * - yField: string - Property name for y-axis, or "$count" for count aggregation
 * - title: string - Optional chart title
 * - onDataPointSelect: (dataPoint: any) => void - Callback when data point is clicked
 */

import { useState, useEffect, useRef, useMemo } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import * as d3 from "d3"
import { cn } from "@/lib/utils"
import type { SectionRendererProps } from "../sectionImplementations"

// ============================================================================
// Types
// ============================================================================

interface ChartConfig {
  /** Schema name to query */
  schema?: string
  /** Model/collection name */
  model?: string
  /** Type of chart to render */
  chartType?: "bar" | "line"
  /** Property name for x-axis */
  xField?: string
  /** Property name for y-axis, or "$count" for count aggregation */
  yField?: string
  /** Optional chart title */
  title?: string
  /** Callback when data point is clicked */
  onDataPointSelect?: (dataPoint: any) => void
  /** Direct data array (bypasses domain store query) */
  data?: Array<{ x: string | number; y: number } | Record<string, any>>
}

interface ChartDataPoint {
  x: string | number
  y: number
  original?: any
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get collection name from model name (e.g., "Requirement" -> "requirementCollection")
 */
function getCollectionName(model: string): string {
  return `${model.charAt(0).toLowerCase()}${model.slice(1)}Collection`
}

/**
 * Aggregate data by field for count aggregation
 */
function aggregateByField(data: any[], field: string): ChartDataPoint[] {
  const counts = new Map<string, number>()

  for (const item of data) {
    const value = String(item[field] ?? "unknown")
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }

  return Array.from(counts.entries()).map(([x, y]) => ({
    x,
    y,
  }))
}

/**
 * Extract data points from raw data
 */
function extractDataPoints(
  data: any[],
  xField: string,
  yField: string
): ChartDataPoint[] {
  // Special case: $count aggregation
  if (yField === "$count") {
    return aggregateByField(data, xField)
  }

  // Direct field mapping
  return data.map(item => ({
    x: item[xField] ?? "",
    y: Number(item[yField]) || 0,
    original: item,
  }))
}

// ============================================================================
// Chart Rendering
// ============================================================================

interface ChartRendererProps {
  data: ChartDataPoint[]
  chartType: "bar" | "line"
  width: number
  height: number
  onDataPointSelect?: (dataPoint: ChartDataPoint) => void
}

function renderBarChart(
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
  data: ChartDataPoint[],
  width: number,
  height: number,
  onDataPointSelect?: (dataPoint: ChartDataPoint) => void
) {
  const margin = { top: 20, right: 20, bottom: 40, left: 50 }
  const innerWidth = width - margin.left - margin.right
  const innerHeight = height - margin.top - margin.bottom

  // Clear previous content
  svg.selectAll("*").remove()

  const g = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`)

  // X scale (band for categorical data)
  const x = d3
    .scaleBand()
    .domain(data.map(d => String(d.x)))
    .range([0, innerWidth])
    .padding(0.2)

  // Y scale (linear for values)
  const y = d3
    .scaleLinear()
    .domain([0, d3.max(data, d => d.y) ?? 0])
    .nice()
    .range([innerHeight, 0])

  // X axis
  g.append("g")
    .attr("class", "x-axis")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(d3.axisBottom(x))
    .selectAll("text")
    .attr("class", "fill-muted-foreground text-xs")
    .attr("transform", "rotate(-45)")
    .style("text-anchor", "end")

  // Y axis
  g.append("g")
    .attr("class", "y-axis")
    .call(d3.axisLeft(y).ticks(5))
    .selectAll("text")
    .attr("class", "fill-muted-foreground text-xs")

  // Style axis lines
  g.selectAll(".domain, .tick line")
    .attr("stroke", "currentColor")
    .attr("class", "text-border")

  // Bars
  g.selectAll(".bar")
    .data(data)
    .enter()
    .append("rect")
    .attr("class", "bar fill-primary cursor-pointer transition-opacity hover:opacity-80")
    .attr("x", d => x(String(d.x)) ?? 0)
    .attr("y", d => y(d.y))
    .attr("width", x.bandwidth())
    .attr("height", d => innerHeight - y(d.y))
    .attr("rx", 2)
    .on("click", (event, d) => {
      onDataPointSelect?.(d)
    })

  // Tooltip group (hidden by default)
  const tooltip = g
    .append("g")
    .attr("class", "tooltip")
    .style("opacity", 0)
    .style("pointer-events", "none")

  tooltip
    .append("rect")
    .attr("class", "fill-popover stroke-border")
    .attr("rx", 4)
    .attr("ry", 4)

  tooltip
    .append("text")
    .attr("class", "fill-popover-foreground text-xs")
    .attr("text-anchor", "middle")
    .attr("dy", "1em")

  // Add tooltip behavior
  g.selectAll(".bar")
    .on("mouseenter", function(event, d: any) {
      const bar = d3.select(this)
      const xPos = (x(String(d.x)) ?? 0) + x.bandwidth() / 2
      const yPos = y(d.y) - 10

      tooltip
        .attr("transform", `translate(${xPos},${yPos})`)
        .style("opacity", 1)

      tooltip.select("text").text(`${d.x}: ${d.y}`)

      const textNode = tooltip.select("text").node() as SVGTextElement
      const bbox = textNode.getBBox()
      tooltip
        .select("rect")
        .attr("x", bbox.x - 8)
        .attr("y", bbox.y - 4)
        .attr("width", bbox.width + 16)
        .attr("height", bbox.height + 8)
    })
    .on("mouseleave", () => {
      tooltip.style("opacity", 0)
    })
}

function renderLineChart(
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
  data: ChartDataPoint[],
  width: number,
  height: number,
  onDataPointSelect?: (dataPoint: ChartDataPoint) => void
) {
  const margin = { top: 20, right: 20, bottom: 40, left: 50 }
  const innerWidth = width - margin.left - margin.right
  const innerHeight = height - margin.top - margin.bottom

  // Clear previous content
  svg.selectAll("*").remove()

  const g = svg
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`)

  // X scale (point for categorical data in line chart)
  const x = d3
    .scalePoint()
    .domain(data.map(d => String(d.x)))
    .range([0, innerWidth])
    .padding(0.5)

  // Y scale
  const y = d3
    .scaleLinear()
    .domain([0, d3.max(data, d => d.y) ?? 0])
    .nice()
    .range([innerHeight, 0])

  // X axis
  g.append("g")
    .attr("class", "x-axis")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(d3.axisBottom(x))
    .selectAll("text")
    .attr("class", "fill-muted-foreground text-xs")
    .attr("transform", "rotate(-45)")
    .style("text-anchor", "end")

  // Y axis
  g.append("g")
    .attr("class", "y-axis")
    .call(d3.axisLeft(y).ticks(5))
    .selectAll("text")
    .attr("class", "fill-muted-foreground text-xs")

  // Style axis lines
  g.selectAll(".domain, .tick line")
    .attr("stroke", "currentColor")
    .attr("class", "text-border")

  // Line generator
  const line = d3
    .line<ChartDataPoint>()
    .x(d => x(String(d.x)) ?? 0)
    .y(d => y(d.y))
    .curve(d3.curveMonotoneX)

  // Draw line
  g.append("path")
    .datum(data)
    .attr("class", "stroke-primary fill-none")
    .attr("stroke-width", 2)
    .attr("d", line)

  // Draw data points
  g.selectAll(".point")
    .data(data)
    .enter()
    .append("circle")
    .attr("class", "point fill-primary stroke-background cursor-pointer transition-all hover:r-6")
    .attr("cx", d => x(String(d.x)) ?? 0)
    .attr("cy", d => y(d.y))
    .attr("r", 4)
    .attr("stroke-width", 2)
    .on("click", (event, d) => {
      onDataPointSelect?.(d)
    })

  // Tooltip group
  const tooltip = g
    .append("g")
    .attr("class", "tooltip")
    .style("opacity", 0)
    .style("pointer-events", "none")

  tooltip
    .append("rect")
    .attr("class", "fill-popover stroke-border")
    .attr("rx", 4)
    .attr("ry", 4)

  tooltip
    .append("text")
    .attr("class", "fill-popover-foreground text-xs")
    .attr("text-anchor", "middle")
    .attr("dy", "1em")

  // Add tooltip behavior
  g.selectAll(".point")
    .on("mouseenter", function(event, d: any) {
      const xPos = x(String(d.x)) ?? 0
      const yPos = y(d.y) - 15

      d3.select(this).attr("r", 6)

      tooltip
        .attr("transform", `translate(${xPos},${yPos})`)
        .style("opacity", 1)

      tooltip.select("text").text(`${d.x}: ${d.y}`)

      const textNode = tooltip.select("text").node() as SVGTextElement
      const bbox = textNode.getBBox()
      tooltip
        .select("rect")
        .attr("x", bbox.x - 8)
        .attr("y", bbox.y - 4)
        .attr("width", bbox.width + 16)
        .attr("height", bbox.height + 8)
    })
    .on("mouseleave", function() {
      d3.select(this).attr("r", 4)
      tooltip.style("opacity", 0)
    })
}

// ============================================================================
// Component
// ============================================================================

/**
 * ChartSection Component
 *
 * Renders data from any Wavesmith collection as bar or line charts using D3.
 *
 * @param props - SectionRendererProps with feature and config
 */
export const ChartSection = observer(function ChartSection({
  feature,
  config,
}: SectionRendererProps) {
  const domains = useDomains()
  const chartConfig = config as ChartConfig | undefined
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [selectedPoint, setSelectedPoint] = useState<ChartDataPoint | null>(null)

  // Extract config with defaults
  const schema = chartConfig?.schema
  const model = chartConfig?.model
  const chartType = chartConfig?.chartType ?? "bar"
  const xField = chartConfig?.xField
  const yField = chartConfig?.yField ?? "$count"
  const title = chartConfig?.title ?? (model ? `${model} Chart` : "Chart")
  const onDataPointSelect = chartConfig?.onDataPointSelect
  const inlineData = chartConfig?.data

  // Handle resize
  useEffect(() => {
    if (!containerRef.current) return

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setDimensions({ width, height: Math.max(height, 300) })
      }
    })

    resizeObserver.observe(containerRef.current)
    return () => resizeObserver.disconnect()
  }, [])

  // Domain key mapping
  const domainKeyMap: Record<string, string> = {
    "platform-features": "platformFeatures",
    "component-builder": "componentBuilder",
    "studio-core": "studioCore",
    "studio-chat": "studioChat",
  }

  // Get data
  const chartData = useMemo(() => {
    // Priority 1: Use inline data if provided (allows direct data passing via config)
    if (inlineData && inlineData.length > 0) {
      // Check if data is already in {x, y} format
      if ('x' in inlineData[0] && 'y' in inlineData[0]) {
        return inlineData as ChartDataPoint[]
      }
      // Otherwise extract using xField/yField
      if (xField) {
        return extractDataPoints(inlineData, xField, yField)
      }
      return []
    }

    // Priority 2: Query domain store if schema/model/xField configured
    if (!schema || !model || !xField) return []

    const domainKey = domainKeyMap[schema] ?? schema
    const domainStore = (domains as any)?.[domainKey]
    if (!domainStore) return []

    const collectionName = getCollectionName(model)
    const collection = domainStore[collectionName]
    if (!collection) return []

    // Fetch data
    let rawData: any[] = []
    if (feature && collection.findBySession) {
      rawData = collection.findBySession(feature.id) ?? []
    } else if (collection.all) {
      rawData = collection.all() ?? []
    } else if (collection.query) {
      rawData = collection.query().toArray() ?? []
    }

    return extractDataPoints(rawData, xField, yField)
  }, [schema, model, xField, yField, feature, domains, inlineData])

  // Render chart
  useEffect(() => {
    if (!svgRef.current || dimensions.width === 0 || chartData.length === 0) return

    const svg = d3.select(svgRef.current)

    const handleSelect = (dataPoint: ChartDataPoint) => {
      setSelectedPoint(dataPoint)
      onDataPointSelect?.(dataPoint)
    }

    if (chartType === "bar") {
      renderBarChart(svg, chartData, dimensions.width, dimensions.height, handleSelect)
    } else {
      renderLineChart(svg, chartData, dimensions.width, dimensions.height, handleSelect)
    }
  }, [chartData, chartType, dimensions, onDataPointSelect])

  // Handle missing configuration (only if no inline data and no domain config)
  if (!inlineData && (!schema || !model || !xField)) {
    return (
      <section data-testid="chart-section" className="h-full">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          {title}
        </h3>
        <div className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">
            Configuration required: provide data array or specify schema, model, and xField
          </p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Direct: {`{ data: [{x: "A", y: 10}, {x: "B", y: 20}], chartType: "bar" }`}
          </p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Domain: {`{ schema: "platform-features", model: "Requirement", xField: "priority", yField: "$count" }`}
          </p>
        </div>
      </section>
    )
  }

  // Handle no domain (only check if not using inline data)
  if (!inlineData && schema) {
    const domainKey = domainKeyMap[schema] ?? schema
    const domainStore = (domains as any)?.[domainKey]
    if (!domainStore) {
      return (
        <section data-testid="chart-section" className="h-full">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            {title}
          </h3>
          <div className="p-4 bg-muted/30 rounded-lg text-center">
            <p className="text-sm text-muted-foreground">
              Domain not found: {schema}
            </p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Available: platform-features, component-builder, studio-core, studio-chat
            </p>
          </div>
        </section>
      )
    }
  }

  // Handle empty data
  if (chartData.length === 0) {
    return (
      <section data-testid="chart-section" className="h-full">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          {title}
        </h3>
        <div className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">
            No data available
          </p>
        </div>
      </section>
    )
  }

  // Render the chart
  return (
    <section data-testid="chart-section" className="h-full flex flex-col">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        {title} ({chartData.length} data points)
      </h3>

      <div
        ref={containerRef}
        className="flex-1 min-h-[300px] border rounded-lg bg-card p-2"
      >
        <svg
          ref={svgRef}
          width={dimensions.width}
          height={dimensions.height}
          className="w-full h-full"
        />
      </div>

      {selectedPoint && (
        <div className="mt-2 p-2 bg-muted/30 rounded text-xs text-muted-foreground">
          Selected: {selectedPoint.x} = {selectedPoint.y}
        </div>
      )}
    </section>
  )
})
