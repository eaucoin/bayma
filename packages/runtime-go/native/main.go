// The Go runtime's host: bayma's line protocol in front of a live Go
// session, whose cells are compiled as plugins and loaded into this process.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"bayma-go-host/output"
	"bayma-go-host/protocol"
	"bayma-go-host/session"
)

func main() {
	os.Exit(run())
}

func run() int {
	out, err := output.Capture()
	if err != nil {
		fmt.Fprintf(os.Stderr, "bayma-go-host: %v\n", err)
		return 1
	}
	fail := func(err error) int {
		fmt.Fprintf(out.HostErr, "bayma-go-host: %v\n", err)
		return 1
	}
	scratch := os.Getenv("BAYMA_GO_SCRATCH_DIR")
	if scratch == "" {
		return fail(errors.New("BAYMA_GO_SCRATCH_DIR is required"))
	}
	cwd, err := os.Getwd()
	if err != nil {
		return fail(err)
	}
	s, err := session.New(filepath.Join(scratch, strconv.Itoa(os.Getpid())), cwd)
	if err != nil {
		return fail(err)
	}
	defer s.Close()

	w := protocol.NewWriter(out.Host)
	w.Prompt()
	for line := range readLines(s) {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, ":exec "):
			execute(s, out, w, strings.TrimPrefix(line, ":exec "))
		case strings.HasPrefix(line, ":probe "):
			w.Ready(strings.TrimPrefix(line, ":probe "))
		case line == ":shutdown":
			return 0
		case line != "":
			fmt.Fprintln(out.HostErr, "bayma-go-host: unknown protocol command")
		}
		w.Prompt()
	}
	return 0
}

// readLines reads stdin's lines on a goroutine of its own. Their end means
// the server that owns this host is gone, and ends the host, even while a
// cell runs, with any build it started.
func readLines(s *session.Session) <-chan string {
	lines := make(chan string)
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64<<10), 1<<20)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		s.Close()
		// A transport that owns the host's process tree makes it its group's
		// leader; the group is then the host and what it started.
		if syscall.Getpgrp() == os.Getpid() {
			syscall.Kill(0, syscall.SIGKILL)
		}
		os.Exit(0)
	}()
	return lines
}

// execute runs the exec a spec file describes. What goroutines wrote while no
// exec ran belongs to none, and is dropped.
func execute(s *session.Session, out *output.Output, w *protocol.Writer, specPath string) {
	spec, err := protocol.ReadSpec(specPath)
	if err != nil {
		if spec.EventPrefix == "" {
			fmt.Fprintf(out.HostErr, "bayma-go-host: %v\n", err)
			return
		}
		w.Text(spec.EventPrefix, "error", err.Error())
		w.Done(spec.EventPrefix)
		return
	}
	out.Stdout.Drain()
	out.Stderr.Drain()
	if spec.Checkpointed() && spec.CheckpointJSON != nil {
		s.SetCheckpoint(checkpointValue(*spec.CheckpointJSON))
	}
	values, err := s.Exec(spec.Code)
	w.Text(spec.EventPrefix, "stdout", out.Stdout.Drain())
	w.Text(spec.EventPrefix, "stderr", out.Stderr.Drain())
	if err != nil {
		w.Text(spec.EventPrefix, "error", session.Demangle(err.Error()))
	} else if values != nil {
		w.Text(spec.EventPrefix, "result", session.Demangle(format(values)))
	}
	if spec.Checkpointed() {
		var notRun *session.NotRunError
		if errors.As(err, &notRun) {
			w.CheckpointPreserved(spec.EventPrefix)
		} else {
			w.Checkpoint(spec.EventPrefix, s.Checkpoint())
		}
	}
	w.Done(spec.EventPrefix)
}

// checkpointValue is the JSON a checkpoint's text holds, or nil for none.
func checkpointValue(text string) json.RawMessage {
	if text == "null" {
		return nil
	}
	return json.RawMessage(text)
}

// format shows a cell's values as fmt.Sprint shows each.
func format(values []any) string {
	parts := make([]string, len(values))
	for i, value := range values {
		parts[i] = fmt.Sprint(value)
	}
	return strings.Join(parts, ", ")
}
