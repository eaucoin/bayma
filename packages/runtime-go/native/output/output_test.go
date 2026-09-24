package output

import (
	"os"
	"strings"
	"testing"
)

func TestDrainTakesWhatWasWrittenSinceTheLast(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	s := newStream(r, w)
	w.WriteString("first\n")
	if got := s.Drain(); got != "first\n" {
		t.Fatalf("got %q", got)
	}
	if got := s.Drain(); got != "" {
		t.Fatalf("got %q", got)
	}
	large := strings.Repeat("x", 1<<20)
	w.WriteString(large)
	if got := s.Drain(); got != large {
		t.Fatalf("got %d bytes", len(got))
	}
}
