import type * as React from "react";

import { cn } from "../../../lib/cn";
import { DESCRIPTION_CLASS, LABEL_CLASS, ROW_CLASS } from "./SettingsUIConstants";

interface SettingsRowProps {
  label: string;
  icon?: React.ReactNode;
  description?: string;
  children?: React.ReactNode;
  className?: string;
}

export function SettingsRow({
  label,
  icon,
  description,
  children,
  className,
}: SettingsRowProps): React.ReactElement {
  return (
    <div className={cn(ROW_CLASS, className)}>
      {icon ? <div className="flex-shrink-0 mr-3">{icon}</div> : null}
      <div className="flex-1 min-w-0 mr-4">
        <div className={LABEL_CLASS}>{label}</div>
        {description ? <div className={cn(DESCRIPTION_CLASS, "mt-0.5")}>{description}</div> : null}
      </div>
      {children ? <div className="flex-shrink-0">{children}</div> : null}
    </div>
  );
}
