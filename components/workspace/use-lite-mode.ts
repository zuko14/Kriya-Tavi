"use client"

import * as React from "react"

import { getLiteMode } from "@/actions/account"
import { liteMode } from "@/lib/lite"

// Lite mode (K10) in the browser: the person's choice, fetched once per page
// load and shared by every component that needs it (thread stream,
// notifications); the Account toggle updates it in place. Until they choose,
// the browser's save-data hint decides.

let chosen: boolean | null | undefined
let loading = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

export function setLiteChoice(value: boolean) {
  chosen = value
  notify()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (chosen === undefined && !loading) {
    loading = true
    getLiteMode().then(
      (value) => {
        chosen = value
        notify()
      },
      () => {
        loading = false
      }
    )
  }
  return () => {
    listeners.delete(listener)
  }
}

export function saveDataHint() {
  return (navigator as { connection?: { saveData?: boolean } }).connection?.saveData
}

// The same answer outside React, at the moment of a request (the thread
// transport). Before the choice has loaded, the save-data hint decides.
export function liteModeNow() {
  return liteMode(chosen ?? null, saveDataHint())
}

export function useLiteMode() {
  const choice = React.useSyncExternalStore(
    subscribe,
    () => chosen,
    () => undefined
  )
  const [saveData, setSaveData] = React.useState<boolean | undefined>(undefined)
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSaveData(saveDataHint())
  }, [])
  return liteMode(choice ?? null, saveData)
}
