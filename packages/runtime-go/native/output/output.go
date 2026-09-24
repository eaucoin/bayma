// Package output owns the process's stdout and stderr. Cells run in this
// process and write to them; the host draws everything written off into
// buffers for good, and writes its own output to copies of the originals.
package output

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"syscall"
)

// Output is the process's captured streams, and the originals for the host.
type Output struct {
	// Host is the original stdout, where the host writes.
	Host *os.File
	// HostErr is the original stderr, for the host's own diagnostics.
	HostErr *os.File
	Stdout  *Stream
	Stderr  *Stream
}

// A Stream is one captured descriptor.
type Stream struct {
	mu      sync.Mutex
	changed *sync.Cond
	text    bytes.Buffer
	file    *os.File // what now stands at the descriptor
	drains  int
}

// Capture takes the process's stdout and stderr.
func Capture() (*Output, error) {
	host, err := duplicate(1)
	if err != nil {
		return nil, err
	}
	hostErr, err := duplicate(2)
	if err != nil {
		return nil, err
	}
	o := &Output{Host: host, HostErr: hostErr}
	if o.Stdout, err = capture(1, os.Stdout); err != nil {
		return nil, err
	}
	if o.Stderr, err = capture(2, os.Stderr); err != nil {
		return nil, err
	}
	return o, nil
}

func duplicate(fd int) (*os.File, error) {
	copied, err := syscall.Dup(fd)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(copied), fmt.Sprintf("host-%d", fd)), nil
}

func capture(fd int, file *os.File) (*Stream, error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	if err := syscall.Dup2(int(w.Fd()), fd); err != nil {
		return nil, err
	}
	return newStream(r, file), nil
}

// newStream reads r, which receives what is written to file.
func newStream(r io.Reader, file *os.File) *Stream {
	s := &Stream{file: file}
	s.changed = sync.NewCond(&s.mu)
	go func() {
		chunk := make([]byte, 64<<10)
		for {
			n, err := r.Read(chunk)
			s.mu.Lock()
			s.text.Write(chunk[:n])
			s.changed.Broadcast()
			s.mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	return s
}

// Drain returns what was written to the stream since the last drain. A marker
// written after it proves everything before it has been read.
func (s *Stream) Drain() string {
	s.mu.Lock()
	s.drains++
	marker := fmt.Sprintf("\x00bayma-drain-%d\x00", s.drains)
	s.mu.Unlock()
	s.file.WriteString(marker)

	s.mu.Lock()
	defer s.mu.Unlock()
	for !strings.Contains(s.text.String(), marker) {
		s.changed.Wait()
	}
	before, after, _ := strings.Cut(s.text.String(), marker)
	s.text.Reset()
	s.text.WriteString(after)
	return before
}
