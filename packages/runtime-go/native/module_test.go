package main

import (
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"testing"
)

// Hosts that claim modules at once, one of them of the pid of a host that
// ended and left its module, as a recycled host may be, each get one of their
// own, and none removes or enters another's.
func TestClaimGivesEachHostAModuleOfItsOwn(t *testing.T) {
	scratch := t.TempDir()
	// A host of pid 41 ended, and left its module and its plugins.
	left := filepath.Join(scratch, "41-0011223344556677")
	if err := os.MkdirAll(filepath.Join(left, "plugins"), 0o755); err != nil {
		t.Fatal(err)
	}
	plugin := filepath.Join(left, "plugins", "c0001.so")
	if err := os.WriteFile(plugin, []byte("mapped by a host a save caught"), 0o644); err != nil {
		t.Fatal(err)
	}

	const hosts = 16
	dirs := make([]string, hosts)
	var wg sync.WaitGroup
	for i := range hosts {
		wg.Go(func() {
			// Half of them of the pid that ended.
			pid := 41
			if i%2 == 1 {
				pid = 42
			}
			dir, err := claimModule(scratch, pid)
			if err != nil {
				t.Error(err)
				return
			}
			dirs[i] = dir
		})
	}
	wg.Wait()

	name := regexp.MustCompile(`^4[12]-[0-9a-f]{16}$`)
	seen := map[string]bool{left: true}
	for _, dir := range dirs {
		if !name.MatchString(filepath.Base(dir)) || filepath.Dir(dir) != scratch {
			t.Fatalf("a module at %q", dir)
		}
		if seen[dir] {
			t.Fatalf("two hosts share the module %q", dir)
		}
		seen[dir] = true
		if entries, err := os.ReadDir(dir); err != nil || len(entries) != 0 {
			t.Fatalf("the new module %q holds %v: %v", dir, entries, err)
		}
	}
	if data, err := os.ReadFile(plugin); err != nil || string(data) != "mapped by a host a save caught" {
		t.Fatalf("the module a host left: %q, %v", data, err)
	}
}
