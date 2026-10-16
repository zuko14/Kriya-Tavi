"use client"

import { memo } from "react"
import { createCodePlugin } from "@streamdown/code"
import { Streamdown } from "streamdown"

import { cn } from "@/lib/utils"

const code = createCodePlugin({ themes: ["github-light", "github-dark-dimmed"] })

export const Markdown = memo(function Markdown({
  children,
  streaming,
  className,
}: {
  children: string
  streaming?: boolean
  className?: string
}) {
  return (
    <Streamdown
      className={cn("prose-kriya min-w-0", className)}
      plugins={{ code }}
      isAnimating={streaming}
      parseIncompleteMarkdown
    >
      {children}
    </Streamdown>
  )
})
