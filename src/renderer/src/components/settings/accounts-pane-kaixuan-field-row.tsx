// What: the label-above-input layout shared by the custom-provider dialog fields.

export function FieldRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  // Why: Label owns its typography (per shadcn/no-restyle); we render the field
  // label as a sibling span so the form stays compact without restyling Label.
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      {children}
    </div>
  )
}
