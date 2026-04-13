interface PageHeaderProps {
  title: string;
  subtitle?: React.ReactNode;
  /** Optional right-side slot — typically a refresh button or filter row. */
  actions?: React.ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="px-8 py-6 border-b border-border bg-surface-raised">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-ink truncate">{title}</h1>
          {subtitle && (
            <p className="mt-1 text-sm text-ink-muted truncate">{subtitle}</p>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
    </header>
  );
}
