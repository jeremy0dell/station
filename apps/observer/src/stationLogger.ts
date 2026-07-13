/**
 * DRIVEN PORT
 *
 * Records Observer operational events without exposing their storage
 * representation or destination.
 */
export interface StationLogger {
  info(message: string, attributes?: Record<string, unknown>): Promise<void>;
  warn(message: string, attributes?: Record<string, unknown>): Promise<void>;
  error(message: string, attributes?: Record<string, unknown>): Promise<void>;
}
