export function captureTmuxCallerClaims(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const claims: Record<string, string> = {};
  if (environment.TMUX !== undefined) claims.TMUX = environment.TMUX;
  if (environment.TMUX_PANE !== undefined) claims.TMUX_PANE = environment.TMUX_PANE;
  return claims;
}
