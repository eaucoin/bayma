package session

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These tests build and load real plugins: they need the go command and a C
// compiler, as the host does.

func newSession(t *testing.T, cwd string) *Session {
	t.Helper()
	s, err := New(filepath.Join(t.TempDir(), "session"), cwd)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func result(t *testing.T, s *Session, cell string) string {
	t.Helper()
	values, err := s.Exec(cell)
	if err != nil {
		t.Fatalf("%q: %v", cell, err)
	}
	parts := make([]string, len(values))
	for i, value := range values {
		parts[i] = fmt.Sprint(value)
	}
	return strings.Join(parts, ", ")
}

func TestStateIsLive(t *testing.T) {
	s := newSession(t, t.TempDir())
	result(t, s, "keep := 41")
	result(t, s, "keep++")
	if got := result(t, s, "keep + 1"); got != "43" {
		t.Fatalf("got %s", got)
	}
}

func TestASessionIsOnePackage(t *testing.T) {
	s := newSession(t, t.TempDir())
	result(t, s, "type tally struct{ n int }\n\nfunc (t *tally) add() { t.n++ }\n\ncount := &tally{}")
	if got := result(t, s, "count.add()\ncount.n"); got != "1" {
		t.Fatalf("got %s", got)
	}
	result(t, s, `import "strings"`)
	if got := result(t, s, `strings.ToUpper("later")`); got != "LATER" {
		t.Fatalf("an import serves later cells: got %s", got)
	}
}

func TestRedefinedNamesReplaceTheOld(t *testing.T) {
	s := newSession(t, t.TempDir())
	result(t, s, "name := 1")
	result(t, s, `name := "two"`)
	if got := result(t, s, "name + name"); got != "twotwo" {
		t.Fatalf("got %s", got)
	}
}

func TestACellThatDoesNotCompileNeverRuns(t *testing.T) {
	s := newSession(t, t.TempDir())
	result(t, s, "type tally struct{ n int }\ncount := &tally{}")
	_, err := s.Exec("count.missing")
	var notRun *NotRunError
	if !errors.As(err, &notRun) || !strings.Contains(err.Error(), "type *tally has no field or method missing") {
		t.Fatalf("got %v", err)
	}
}

func TestAPanicEndsItsCellOnly(t *testing.T) {
	s := newSession(t, t.TempDir())
	_, err := s.Exec(`panic("boom")`)
	var notRun *NotRunError
	if err == nil || errors.As(err, &notRun) || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("got %v", err)
	}
	if got := result(t, s, "40 + 2"); got != "42" {
		t.Fatalf("got %s", got)
	}
}

func TestRenamedFieldsStayOutOfJSON(t *testing.T) {
	s := newSession(t, t.TempDir())
	result(t, s, "import \"encoding/json\"\ntype point struct {\n\tName string\n\tsecret int\n}\nv := point{\"a\", 1}")
	if got := result(t, s, "data, _ := json.Marshal(v)\nstring(data)"); got != `{"Name":"a"}` {
		t.Fatalf("got %s", got)
	}
	if got := result(t, s, "v.secret"); got != "1" {
		t.Fatalf("got %s", got)
	}
}

func TestCheckpoints(t *testing.T) {
	s := newSession(t, t.TempDir())
	if s.Checkpoint() != nil {
		t.Fatal("a new session has no checkpoint")
	}
	result(t, s, `bayma_write_checkpoint(map[string]int{"saved": 99})`)
	if got := string(s.Checkpoint()); got != `{"saved":99}` {
		t.Fatalf("got %s", got)
	}
	s.SetCheckpoint([]byte(`{"saved":7}`))
	if got := result(t, s, "var restored map[string]int\nbayma_read_checkpoint(&restored)"); got != "<nil>" {
		t.Fatalf("got %s", got)
	}
	if got := result(t, s, `restored["saved"]`); got != "7" {
		t.Fatalf("got %s", got)
	}
}

func TestTheWorkingDirectorysModule(t *testing.T) {
	project := t.TempDir()
	os.MkdirAll(filepath.Join(project, "answer"), 0o755)
	os.WriteFile(filepath.Join(project, "go.mod"), []byte("module helper\n\ngo 1.27\n"), 0o644)
	os.WriteFile(filepath.Join(project, "answer", "answer.go"), []byte("package answer\n\nfunc Value() int { return 42 }\n"), 0o644)
	s := newSession(t, project)
	if got := result(t, s, "import \"helper/answer\"\nanswer.Value()"); got != "42" {
		t.Fatalf("got %s", got)
	}
}

func TestVersionConflicts(t *testing.T) {
	loaded := map[string]string{"example.com/a": "v1.0.0"}
	if err := versionConflict(loaded, map[string]string{"example.com/a": "v1.0.0", "example.com/b": "v2.0.0"}); err != nil {
		t.Fatalf("got %v", err)
	}
	err := versionConflict(loaded, map[string]string{"example.com/a": "v1.1.0"})
	if err == nil || err.Error() != "this cell needs example.com/a v1.1.0, and the session has loaded v1.0.0; a new session can use v1.1.0" {
		t.Fatalf("got %v", err)
	}
}

func TestDemangle(t *testing.T) {
	if got := Demangle("c0003.Bayma_count.Bayma_n undefined (type *c0002.Bayma_tally)"); got != "count.n undefined (type *tally)" {
		t.Fatalf("got %s", got)
	}
}
