import * as React from "react"

import { SECTION_DESCRIPTION_CLASS, SECTION_TITLE_CLASS } from "./SettingsUIConstants"

interface SettingsSectionProps {
  title: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
}

export function SettingsSection({
  title,
  description,
  action,
  children,
}: SettingsSectionProps): React.ReactElement {
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <h4 className={SECTION_TITLE_CLASS}>{title}</h4>
          {description ? <p className={SECTION_DESCRIPTION_CLASS}>{description}</p> : null}
        </div>
        {action ? <div className="flex-shrink-0 ml-4">{action}</div> : null}
      </div>
      {children}
    </div>
  )
}

