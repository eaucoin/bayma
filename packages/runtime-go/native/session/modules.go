package session

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// initModule writes the session module. A module in cwd is available to its
// cells, at what the directory holds, with the versions it requires.
func (s *Session) initModule(cwd string) error {
	module := fmt.Sprintf("module %s\n\ngo 1.27.1\n", s.module)
	if _, err := os.Stat(filepath.Join(cwd, "go.mod")); err == nil {
		out, err := goRun(cwd, "mod", "edit", "-json")
		if err != nil {
			return err
		}
		var project struct{ Module struct{ Path string } }
		if err := json.Unmarshal([]byte(out), &project); err != nil {
			return fmt.Errorf("reading %s: %w", filepath.Join(cwd, "go.mod"), err)
		}
		module += fmt.Sprintf("\nrequire %s v0.0.0\n\nreplace %s => %q\n",
			project.Module.Path, project.Module.Path, cwd)
	}
	return s.write("go.mod", module)
}

// fetch adds the modules of imports the session cannot yet resolve, and
// returns what undoes that.
func (s *Session) fetch(imports []string) (restore func(), err error) {
	modFile := filepath.Join(s.dir, "go.mod")
	sumFile := filepath.Join(s.dir, "go.sum")
	mod, _ := os.ReadFile(modFile)
	sum, sumErr := os.ReadFile(sumFile)
	restore = func() {
		os.WriteFile(modFile, mod, 0o644)
		if sumErr == nil {
			os.WriteFile(sumFile, sum, 0o644)
		} else {
			os.Remove(sumFile)
		}
	}
	for _, path := range imports {
		// A standard library path's first element has no dot.
		first, _, _ := strings.Cut(path, "/")
		if !strings.Contains(first, ".") {
			continue
		}
		if out, _ := goRun(s.dir, "list", "-e", "-f", "{{if .Error}}missing{{end}}", path); strings.TrimSpace(out) != "missing" {
			continue
		}
		if _, err := goRun(s.dir, "get", path); err != nil {
			restore()
			return nil, err
		}
	}
	return restore, nil
}

// checkVersions refuses a cell whose plugin would bring a module at another
// version than the one this process loaded: Go loads one copy of a package
// per process.
func (s *Session) checkVersions(name string) error {
	versions, err := s.moduleVersions(name)
	if err != nil {
		return err
	}
	return versionConflict(s.loaded, versions)
}

// versionConflict names a module needed at another version than the one
// loaded.
func versionConflict(loaded, needed map[string]string) error {
	modules := make([]string, 0, len(needed))
	for module := range needed {
		modules = append(modules, module)
	}
	sort.Strings(modules)
	for _, module := range modules {
		if version, ok := loaded[module]; ok && version != needed[module] {
			return fmt.Errorf("this cell needs %s %s, and the session has loaded %s; a new session can use %s",
				module, needed[module], version, needed[module])
		}
	}
	return nil
}

// recordVersions notes the modules a loaded cell brought.
func (s *Session) recordVersions(name string) error {
	versions, err := s.moduleVersions(name)
	if err != nil {
		return err
	}
	for module, version := range versions {
		s.loaded[module] = version
	}
	return nil
}

// moduleVersions are the modules a cell's plugin is built from, but for the
// session's own.
func (s *Session) moduleVersions(name string) (map[string]string, error) {
	out, err := goRun(s.dir, "list", "-deps", "-f", "{{with .Module}}{{.Path}} {{.Version}}{{end}}", "./plugins/"+name)
	if err != nil {
		return nil, err
	}
	versions := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if module, version, ok := strings.Cut(line, " "); ok && module != s.module {
			versions[module] = version
		}
	}
	return versions, nil
}
