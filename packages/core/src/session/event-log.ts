import type { SessionEvent, SessionEventRecord } from "./events.ts";

// A bounded, sequence-numbered log of session events. The server keeps one
// across all sessions and every session keeps its own; both are read through
// the `bayma:///server/events` and `bayma:///session/{id}` resources.

const EVENT_LOG_LIMIT = 512;
const EVENT_LOG_MAX_BYTES = 4 * 1024 * 1024;

function eventRecordBytes(record: SessionEventRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}

export class EventLog {
  private readonly records: SessionEventRecord[] = [];
  private retainedBytes = 0;
  private nextSeq = 1;

  append(event: SessionEvent, occurredAtMs = Date.now()): SessionEventRecord {
    const record: SessionEventRecord = {
      seq: this.nextSeq,
      occurredAtMs,
      event,
    };
    this.nextSeq += 1;
    this.records.push(record);
    this.retainedBytes += eventRecordBytes(record);
    while (
      this.records.length > 0 &&
      (this.records.length > EVENT_LOG_LIMIT ||
        this.retainedBytes > EVENT_LOG_MAX_BYTES)
    ) {
      this.retainedBytes -= eventRecordBytes(this.records.shift()!);
    }
    return record;
  }

  /** Copies of every retained record at or after `fromSeq`. */
  since(fromSeq = 1): SessionEventRecord[] {
    return this.records
      .filter((record) => record.seq >= fromSeq)
      .map((record) => ({ ...record, event: { ...record.event } }));
  }
}
