// Package protocol is bayma's line protocol, as a host speaks it: the prompt,
// execution specs, and the event lines each exec answers with.
package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
)

// Prompt is written whenever the host is ready for a command.
const Prompt = "BAYMA> "

// MaxMessageBytes leaves framing headroom below the core's 64 KiB message
// ceiling, as every host does, so the host's own truncation is the one that
// shows.
const MaxMessageBytes = 60 * 1024

const truncationMarker = "…Bayma truncated runtime message…"

// A Spec is what one exec asks for.
type Spec struct {
	SchemaVersion  int    `json:"schema_version"`
	EventPrefix    string `json:"event_prefix"`
	Code           string `json:"code"`
	DurabilityMode string `json:"durability_mode"`
	// CheckpointJSON is the session's checkpoint, as JSON text.
	CheckpointJSON *string `json:"checkpoint_json"`
}

// Checkpointed reports whether the exec keeps a checkpoint.
func (s Spec) Checkpointed() bool { return s.DurabilityMode == "checkpointed" }

// ReadSpec reads and checks a spec file.
func ReadSpec(path string) (Spec, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Spec{}, err
	}
	var spec Spec
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&spec); err != nil {
		return Spec{}, fmt.Errorf("invalid execution spec: %w", err)
	}
	switch {
	case spec.SchemaVersion != 1:
		return spec, fmt.Errorf("unsupported Go execution protocol version %d", spec.SchemaVersion)
	case spec.EventPrefix == "":
		return spec, fmt.Errorf("execution spec names no event prefix")
	case spec.DurabilityMode != "ephemeral" && spec.DurabilityMode != "checkpointed":
		return spec, fmt.Errorf("unsupported durability mode %s", spec.DurabilityMode)
	}
	return spec, nil
}

// A Writer writes the protocol to the host's own stdout.
type Writer struct{ out io.Writer }

func NewWriter(out io.Writer) *Writer { return &Writer{out} }

func (w *Writer) Prompt() { io.WriteString(w.out, Prompt) }

func (w *Writer) Ready(nonce string) { fmt.Fprintf(w.out, "__BAYMA_READY_%s__\n", nonce) }

// Text emits a message of kind stdout, stderr, result, or error, unless it is
// empty.
func (w *Writer) Text(prefix, kind, text string) {
	if text != "" {
		w.emit(prefix, map[string]any{"kind": kind, "text": Bounded(text)})
	}
}

// Checkpoint emits the session's checkpoint: the JSON its cells last wrote.
func (w *Writer) Checkpoint(prefix string, value json.RawMessage) {
	if value == nil {
		value = json.RawMessage("null")
	}
	w.emit(prefix, map[string]any{"kind": "checkpoint", "checkpoint": map[string]any{
		"runtimeId":    "go",
		"codecId":      "json-v1",
		"codecVersion": 1,
		"payloadKind":  "json-inline",
		"inlineJson":   value,
		"compatibility": map[string]string{
			"runtimeVersion":  runtime.Version(),
			"languageVersion": runtime.Version(),
			"platform":        runtime.GOOS,
			"arch":            runtime.GOARCH,
		},
	}})
}

// CheckpointPreserved emits that the exec left the checkpoint as it was.
func (w *Writer) CheckpointPreserved(prefix string) {
	w.emit(prefix, map[string]any{"kind": "checkpoint-preserved"})
}

// Done ends an exec's events.
func (w *Writer) Done(prefix string) { w.emit(prefix, map[string]any{"kind": "done"}) }

func (w *Writer) emit(prefix string, event map[string]any) {
	line, _ := json.Marshal(event)
	fmt.Fprintf(w.out, "%s%s\n", prefix, line)
}

// Bounded is text with its middle cut out to fit MaxMessageBytes.
func Bounded(text string) string {
	if len(text) <= MaxMessageBytes {
		return text
	}
	payload := MaxMessageBytes - len(truncationMarker)
	left := payload / 2
	for left > 0 && !startsRune(text[left]) {
		left--
	}
	right := len(text) - (payload - payload/2)
	for right < len(text) && !startsRune(text[right]) {
		right++
	}
	return text[:left] + truncationMarker + text[right:]
}

func startsRune(b byte) bool { return b&0xC0 != 0x80 }
