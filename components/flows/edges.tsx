"use client"

import * as React from "react"
import { BaseEdge, getBezierPath, getSmoothStepPath, type EdgeProps } from "@xyflow/react"

import { ALTERNATE } from "@/components/flows/look"
import { wirePoints, type Point } from "@/lib/flows/layout"
import { cn } from "@/lib/utils"

const RADIUS = 12

export type EdgeData = {
  port: string
  route?: Point[]
  // During a run: taken, dead, or just being walked
  run?: "taken" | "dead" | "live"
  mark?: "added"
}

// An orthogonal polyline with rounded corners, through ELK's bend points
function rounded(points: Point[]) {
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]]
    const r = Math.min(
      RADIUS,
      Math.hypot(b.x - a.x, b.y - a.y) / 2,
      Math.hypot(c.x - b.x, c.y - b.y) / 2
    )
    const towards = (from: Point, to: Point) => {
      const length = Math.hypot(to.x - from.x, to.y - from.y) || 1
      return {
        x: from.x + ((to.x - from.x) / length) * r,
        y: from.y + ((to.y - from.y) / length) * r,
      }
    }
    const before = towards(b, a)
    const after = towards(b, c)
    d += ` L ${before.x} ${before.y} Q ${b.x} ${b.y} ${after.x} ${after.y}`
  }
  const last = points.at(-1)!
  return `${d} L ${last.x} ${last.y}`
}

export function Routed({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const { port, route, run, mark } = (data ?? {}) as EdgeData
  // Already in line: a straight wire, whatever rounding left in the route
  const straight = Math.abs(sourceX - targetX) < 3
  const wire = route
    ? wirePoints({ x: sourceX, y: sourceY }, route, { x: targetX, y: targetY })
    : null
  const path = straight
    ? `M ${sourceX} ${sourceY} L ${sourceX} ${targetY}`
    : wire
      ? rounded(wire)
      : getSmoothStepPath({
          sourceX,
          sourceY,
          targetX,
          targetY,
          sourcePosition,
          targetPosition,
          borderRadius: RADIUS,
          offset: 24,
        })[0]
  const colour =
    run === "taken"
      ? "var(--rigel)"
      : mark === "added"
        ? "var(--ok)"
        : port === "error"
          ? "var(--destructive)"
          : ALTERNATE.has(port)
            ? "color-mix(in oklch, var(--betelgeuse) 75%, transparent)"
            : "var(--muted-foreground)"
  const dead = run === "dead"
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={18}
        className={cn("kflow-edge", run === "live" && "kflow-edge-live")}
        style={{
          stroke: colour,
          strokeWidth: run === "taken" ? 2 : 1.5,
          strokeDasharray: port === "error" ? "5 4" : undefined,
          opacity: dead ? 0.28 : 1,
        }}
      />
      <path
        className="kflow-arrow"
        d={`M ${targetX - 4.5} ${targetY - 8} L ${targetX} ${targetY - 1} L ${targetX + 4.5} ${targetY - 8} Z`}
        style={{ fill: colour, opacity: dead ? 0.28 : 1 }}
      />
    </>
  )
}

// Where a selected node's data comes from (SD-06): never selectable, never saved
export function DataLink({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })
  return (
    <path
      d={path}
      fill="none"
      style={{
        stroke: "var(--rigel)",
        strokeWidth: 1.25,
        strokeDasharray: "2 5",
        strokeLinecap: "round",
      }}
    />
  )
}
