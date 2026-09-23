function describeFailureInner(
  error: unknown,
  activeAggregates: Set<AggregateError>,
): string {
  if (error instanceof AggregateError) {
    if (activeAggregates.has(error)) {
      return "AggregateError: circular aggregate cause";
    }
    activeAggregates.add(error);
    const nested = error.errors
      .map((nestedError) => describeFailureInner(nestedError, activeAggregates))
      .join("; ");
    activeAggregates.delete(error);
    const suffix = nested ? `: ${nested}` : "";
    return suffix && error.message.endsWith(suffix)
      ? error.message
      : `${error.message}${suffix}`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function describeFailure(error: unknown): string {
  return describeFailureInner(error, new Set());
}

export function aggregateFailure(
  message: string,
  failures: unknown[],
): AggregateError {
  const details = failures.map(describeFailure).join("; ");
  return new AggregateError(
    failures,
    details ? `${message}: ${details}` : message,
  );
}

/** A failure rendered for a quarantine reason or a diagnostic: stack when there is one. */
export function failureDetail(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}
