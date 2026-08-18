const RESPONSIVE_AFFORDANCE_BREAKPOINT = 90;

export function dashboardShellActionLabel(columns: number): string {
  return columns < RESPONSIVE_AFFORDANCE_BREAKPOINT ? "[sh]" : "[shell]";
}

export function dashboardQuickSessionActionLabel(columns: number): string {
  return columns < RESPONSIVE_AFFORDANCE_BREAKPOINT ? "[qs]" : "[quick session]";
}
