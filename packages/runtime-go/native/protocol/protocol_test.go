package protocol

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestBoundedKeepsHeadAndTail(t *testing.T) {
	text := "head" + strings.Repeat("€", MaxMessageBytes) + "tail"
	bounded := Bounded(text)
	if len(bounded) > MaxMessageBytes || !utf8.ValidString(bounded) ||
		!strings.HasPrefix(bounded, "head") || !strings.HasSuffix(bounded, "tail") ||
		!strings.Contains(bounded, truncationMarker) {
		t.Fatalf("bounded to %d bytes: %.40q…", len(bounded), bounded)
	}
	if Bounded("short") != "short" {
		t.Fatal("short text is kept whole")
	}
}

func TestReadSpec(t *testing.T) {
	write := func(spec string) string {
		path := filepath.Join(t.TempDir(), "spec.json")
		os.WriteFile(path, []byte(spec), 0o644)
		return path
	}
	spec, err := ReadSpec(write(`{"schema_version":1,"event_prefix":"p","code":"1","durability_mode":"checkpointed","checkpoint_json":"{}"}`))
	if err != nil || !spec.Checkpointed() || *spec.CheckpointJSON != "{}" {
		t.Fatalf("got %+v, %v", spec, err)
	}
	for _, invalid := range []string{
		`{"schema_version":2,"event_prefix":"p","code":"","durability_mode":"ephemeral","checkpoint_json":null}`,
		`{"schema_version":1,"event_prefix":"p","code":"","durability_mode":"lasting","checkpoint_json":null}`,
		`{"schema_version":1,"event_prefix":"p","code":"","durability_mode":"ephemeral","extra":1}`,
	} {
		if _, err := ReadSpec(write(invalid)); err == nil {
			t.Fatalf("accepted %s", invalid)
		}
	}
}

func TestEventLines(t *testing.T) {
	var out bytes.Buffer
	w := NewWriter(&out)
	w.Text("P", "result", "42")
	w.Text("P", "stdout", "")
	w.Checkpoint("P", json.RawMessage(`{"a":1}`))
	w.Done("P")
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 3 || lines[0] != `P{"kind":"result","text":"42"}` || lines[2] != `P{"kind":"done"}` {
		t.Fatalf("got %q", lines)
	}
	var event struct {
		Checkpoint struct {
			CodecID    string          `json:"codecId"`
			InlineJSON json.RawMessage `json:"inlineJson"`
		}
	}
	if err := json.Unmarshal([]byte(strings.TrimPrefix(lines[1], "P")), &event); err != nil ||
		event.Checkpoint.CodecID != "json-v1" || string(event.Checkpoint.InlineJSON) != `{"a":1}` {
		t.Fatalf("got %s", lines[1])
	}
}
