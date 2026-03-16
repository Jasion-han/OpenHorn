import * as React from "react"

import { cn } from "../../../lib/cn"
import { Separator } from "../../ui/separator"
import { CARD_CLASS, DIVIDER_CLASS } from "./SettingsUIConstants"

interface SettingsCardProps {
  children: React.ReactNode
  className?: string
  divided?: boolean
}

export function SettingsCard({
  children,
  className,
  divided = true,
}: SettingsCardProps): React.ReactElement {
  const childArray = React.Children.toArray(children).filter(Boolean)

  return (
    <div className={cn(CARD_CLASS, className)}>
      {divided
        ? childArray.map((child, index) => (
            <React.Fragment key={index}>
              {child}
              {index < childArray.length - 1 ? (
                <Separator className={DIVIDER_CLASS} />
              ) : null}
            </React.Fragment>
          ))
        : children}
    </div>
  )
}

