export const SESSIONS_URI = "bayma:///sessions";
export const SERVER_EVENTS_URI = "bayma:///server/events";

export function sessionUri(sessionId: string): string {
  return `bayma:///session/${sessionId}`;
}

export function sessionExecUri(sessionId: string, execId: string): string {
  return `${sessionUri(sessionId)}/exec/${execId}`;
}

export function sessionExecMessagesUri(
  sessionId: string,
  execId: string,
): string {
  return `${sessionExecUri(sessionId, execId)}/messages`;
}
