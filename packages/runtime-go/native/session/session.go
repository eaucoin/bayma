// Package session is a live Go session: a module whose packages are the
// session's cells, each compiled as a plugin and loaded into this process, so
// everything a cell declares stays live for the cells after it.
package session

import (
	"bytes"
	"fmt"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"plugin"
	"strings"
	"sync/atomic"

	"bayma-go-host/cell"
)

// A Session of cells.
type Session struct {
	dir string
	// module is the session module's path, unique in this process: Go loads
	// a plugin's packages once per process, by path.
	module  string
	cells   int
	names   map[string]binding // what a cell's free names refer to
	exports map[string]string  // compiled export data, by import path
	loaded  map[string]string  // the version of each module this process has loaded
	prelude *plugin.Plugin     // the host's own first cell
}

// A name some cell made: a package it imported, or something it declared.
type binding struct {
	path  string // the package's import path; for a declaration, its cell's
	ident string // the declaration's identifier there; empty for a package
}

// sessions counts the sessions this process has started.
var sessions atomic.Int64

// NotRunError is the error of a cell that never ran: it did not compile, or
// its modules could not be brought into the session.
type NotRunError struct{ Reason error }

func (e *NotRunError) Error() string { return e.Reason.Error() }
func (e *NotRunError) Unwrap() error { return e.Reason }

// New starts a session in dir, whose cells may import the module in cwd, if
// it holds one.
func New(dir, cwd string) (*Session, error) {
	s := &Session{
		dir:     dir,
		module:  fmt.Sprintf("session%d", sessions.Add(1)),
		names:   map[string]binding{},
		exports: map[string]string{},
		loaded:  map[string]string{},
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if err := s.initModule(cwd); err != nil {
		return nil, err
	}
	prelude, _, err := s.run(preludeSource, preludeExports)
	if err != nil {
		return nil, fmt.Errorf("starting the session: %w", err)
	}
	s.prelude = prelude
	return s, nil
}

// Close removes the session's module.
func (s *Session) Close() error { return os.RemoveAll(s.dir) }

// Exec runs one cell, and returns its final expression's values, if it ends
// in one. A cell that never ran returns a *NotRunError; a cell that panicked
// returns the panic.
func (s *Session) Exec(source string) ([]any, error) {
	loaded, hasResult, err := s.run(source, "")
	if err != nil || !hasResult {
		return nil, err
	}
	result, err := loaded.Lookup("Result")
	if err != nil {
		return nil, err
	}
	return result.(func() []any)(), nil
}

// run compiles a cell as the session's next package, loads it, and records
// what it declared and imported. extraExports are declarations its plugin's
// main package adds, which reach the cell's package as `cell`.
func (s *Session) run(source, extraExports string) (loaded *plugin.Plugin, hasResult bool, err error) {
	c, err := cell.Parse(source)
	if err != nil {
		return nil, false, &NotRunError{err}
	}
	restore, err := s.fetch(c.Imports())
	if err != nil {
		return nil, false, &NotRunError{err}
	}
	s.cells++
	name := fmt.Sprintf("c%04d", s.cells)
	path := s.cellPath(name)
	text, pkg, err := s.compile(c, name)
	if err == nil {
		err = s.write(filepath.Join("cells", name, "cell.go"), text)
	}
	hasResult = err == nil && pkg.Scope().Lookup(cell.ResultVar) != nil
	if err == nil {
		err = s.write(filepath.Join("plugins", name, "main.go"), pluginMain(path, hasResult, extraExports))
	}
	if err == nil {
		err = s.checkVersions(name)
	}
	object := filepath.Join(s.dir, "plugins", name+".so")
	if err == nil {
		_, err = goRun(s.dir, "build", "-buildmode=plugin", "-o", object, "./plugins/"+name)
	}
	if err != nil {
		restore()
		return nil, false, &NotRunError{err}
	}
	loaded, err = open(object)
	// A loaded plugin stays mapped; its file is no longer needed.
	os.Remove(object)
	if err != nil {
		return nil, false, err
	}
	// Only a cell that ran becomes part of the session.
	for _, n := range pkg.Scope().Names() {
		switch {
		case n == "_" || strings.HasPrefix(n, cell.Mangle):
		case token.IsExported(n):
			s.names[n] = binding{path: path, ident: n}
		default:
			s.names[n] = binding{path: path, ident: cell.Mangle + n}
		}
	}
	for _, imported := range pkg.Imports() {
		if !strings.HasPrefix(imported.Path(), s.module+"/") {
			s.names[imported.Name()] = binding{path: imported.Path()}
		}
	}
	if err := s.recordVersions(name); err != nil {
		return nil, false, err
	}
	return loaded, hasResult, nil
}

// cellPath is the import path of a cell's package.
func (s *Session) cellPath(name string) string { return s.module + "/cells/" + name }

// goRun runs the go command in dir and returns what it wrote to stdout; its
// error carries what it reported.
func goRun(dir string, args ...string) (string, error) {
	var stdout, stderr bytes.Buffer
	cmd := exec.Command("go", args...)
	cmd.Dir, cmd.Stdout, cmd.Stderr = dir, &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("go %s: %s", args[0],
			Demangle(strings.TrimSpace(stderr.String()+stdout.String())))
	}
	return stdout.String(), nil
}

func (s *Session) write(name, text string) error {
	path := filepath.Join(s.dir, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(text), 0o644)
}

// pluginMain is the main package a cell's plugin is built from: it loads the
// cell's package and hands its result to the host.
func pluginMain(path string, hasResult bool, extraExports string) string {
	var b strings.Builder
	b.WriteString("package main\n\n")
	if hasResult || extraExports != "" {
		fmt.Fprintf(&b, "import cell %q\n\n", path)
	} else {
		fmt.Fprintf(&b, "import _ %q\n\n", path)
	}
	b.WriteString("func main() {}\n")
	if hasResult {
		fmt.Fprintf(&b, "\nfunc Result() []any { return cell.%s }\n", cell.ResultVar)
	}
	if extraExports != "" {
		b.WriteString("\n" + extraExports)
	}
	return b.String()
}

// open loads a cell's plugin, which runs the cell; a panic ends the cell.
func open(object string) (loaded *plugin.Plugin, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	return plugin.Open(object)
}
